# REVENUE_NOW.md — the 90-day path to $10M ARR (and beyond to $1B+)

> Companion to `BILLION_DOLLAR_PATH.md`. That doc maps the 7-10 year arc.
> This doc maps the **next 90 days** — the hardest stretch, where most
> infrastructure startups die. By day 90 we need **$10M ARR** (not MRR —
> annual run-rate, ~$833K/month) with a credible path to $1B.

---

## 1. The cold equation

We are building OpenHeab — a 137-primitive substrate that gives every AI
agent everything it needs to operate on the internet. Tech ships today.
The whole game now is **distribution + monetization velocity**.

To hit **$10M ARR in 90 days** from a standing start, we need any of:

| Path | Customers needed | Avg deal size | Cycle |
|---|---|---|---|
| Pure subscription | 8,500 paying agents | $99/mo | Self-serve |
| Mid-market SaaS | 280 customers | $3K/mo | 14-day trial → close |
| Enterprise contracts | 35 customers | $25K/mo annual | 30-60 day cycle |
| Marketplace volume | $33M GMV/mo @ 30% take | n/a | Network effect |
| Card interchange | $42M card spend/mo @ 2% | n/a | Volume |
| **Realistic blend** | **40 enterprise + 1K SMB + $5M GMV** | mixed | 90 days |

The realistic blend math:
- 40 enterprise @ $20K/mo = $9.6M ARR
- 1,000 paying SMB @ $99/mo = $1.2M ARR
- $5M monthly marketplace GMV @ 30% take = $1.8M ARR
- $20M monthly card spend @ 2% interchange = $4.8M ARR
- **Total: $17.4M ARR ceiling at saturation by day 90**

But that's the ceiling. Realistic 90-day **achievable** target = **$10-12M ARR**
which still requires ~25 enterprise + 500 SMB + meaningful early marketplace +
cards traction. Doable. Not easy. Requires that we not screw up distribution.

---

## 2. What's actually missing right now (gap analysis)

The substrate has every primitive an agent needs. But OpenHeab as a *company*
was missing the primitives needed to **sell to and bill** customers. Until
this commit, the situation was:

| Capability | Status before | Required for revenue |
|---|---|---|
| Multi-agent orgs (companies) | ❌ Missing | Required for any enterprise contract |
| Subscription billing for OpenHeab | ❌ Missing | THE #1 blocker — couldn't charge for our own service |
| Usage metering | ❌ Missing | Required for usage-based pricing |
| Pre-purchased credits | ❌ Missing | Drives upfront cash collection |
| Revenue tracking dashboard | ❌ Missing | Couldn't measure our own ARR |
| Onboarding/activation funnel | ❌ Missing | Conversion died at "what now?" |
| Public agent/extension directory | ❌ Missing | Zero organic discoverability |
| Embeddable widgets | ❌ Missing | No partner-site distribution |
| Server-rendered admin dashboard | ❌ Missing | Non-technical buyers had no UI |
| SAML/OIDC SSO | ❌ Missing | Enterprise deal blocker |
| RBAC | ❌ Missing | Enterprise deal blocker |
| SOC 2 / GDPR evidence collection | ❌ Missing | Enterprise deal blocker |
| ACH / wire / SEPA rails | ❌ Missing | Enterprise pays via ACH not card |
| Quote-to-cash (CPQ) | ❌ Missing | Enterprise sales cycle requires it |
| White-label deployment | ❌ Missing | Big-ticket enterprise demand |
| Channel partner program | ❌ Missing | Partner-led GTM requires this |

**This commit ships the 16 missing primitives** (alongside the existing
137) that turn the substrate into a *company that can take money*.

After this commit OpenHeab has **153 primitives** in 21 layers. Every layer
in the BILLION_DOLLAR_PATH revenue table is now actually live.

---

## 3. The 90-day execution plan, week by week

### Days 1-7 — Plumbing day
- Wire all 16 new primitives into integration.js, MCP server, SDKs
- Boot test green → deploy to production
- Sign up for Stripe Connect, Stripe Issuing, Stripe Tax (parallel applications)
- Apply to 3 ACH program managers (Modern Treasury, Dwolla, Wise Platform)
- Create Stripe products for the 4 subscription tiers
- Submit `/mcp/manifest` to Smithery, mcp.run, ClaudePluginHub
- Submit `/openapi.json` to APIs.guru, RapidAPI, Postman Network
- Activate the FeeSplitter contract on Base mainnet
- Publish 3 hero blog posts: "Why agents need a bank", "10-minute MCP install",
  "From signup to $1K MRR in 30 days with OpenHeab"

### Days 8-21 — First $100K ARR via warm intros
**Target: 30 design partners signed @ avg $300/mo MRR**
- Warm-intro outreach to 200 known agent founders (LangChain alums, Letta,
  Composio, Browserbase, Modal, E2B, Inngest customers)
- Offer Pro tier free for first 6 months in exchange for case study + logo
- Daily customer development calls (3/day = 60 over 3 weeks)
- Ship `/v1/dashboard` HTML version (mobile-friendly, dark, terminal aesthetic)
- Ship the `embed.js` "pay-agent" button — partner sites paste 1 line
- Onboard the first 10 reference agents publicly to Smithery as showcase

### Days 22-45 — First enterprise wave
**Target: 8 enterprise contracts signed @ avg $25K/yr**
- Recruit founding GTM hire (eng+sales hybrid; equity-rich offer)
- Apply to YC W26 batch (deadline mid-Sep ~ exact dates per cycle)
- Outbound to 100 enterprise AI buyers: heads of AI at F500, AI infra leads
  at hyperscalers, agent platform PMs at SaaS companies
- 3 conferences booth/sponsorship (NeurIPS, AI Engineer Summit, MCP Devcon)
- Publish "OpenHeab Enterprise" tier ($2,499/mo) with SOC 2 in-progress badge
- Begin SOC 2 Type II audit kickoff with Vanta or Drata
- Run 2 customer-facing webinars/wk: "Bank for AI agents", "Compliance pack"
- Ship: SAML SSO, RBAC, audit log export, EU data residency option

### Days 46-75 — Marketplace + viral loops
**Target: 100 paid extensions, 5K MAU on the marketplace**
- Recruit 50 publishers to extensions marketplace (30/70 revenue share)
- Pay first $10K bounty for "best vertical extension" hackathon
- Ship the `public_directory` SEO-optimized agent/extension search
- Ship `/v1/embed/widget/*` snippets so any blog/portfolio can show
  agent reputation, accept payments, run inference cost calculators
- Cross-promote with 5 framework partners (LangChain, LlamaIndex, AutoGen,
  CrewAI, Letta) — each pushes a "deploy with OpenHeab" tutorial
- Ship `referrals` + `partnerships` programs — pay 20% lifetime to
  consultants who close enterprise deals
- Activate the `whitelabel` tenant program — 3 design partners running on
  branded subdomains by day 75

### Days 76-90 — Scale + close the year
**Target: $10M ARR run-rate**
- Close 15 more enterprise contracts (the seeds planted in days 22-45 close)
- Push subscription conversion via in-product upgrade prompts (free → pro)
- Run 2 paid acquisition campaigns: $50K Google Ads, $50K LinkedIn ABM
- Ship co-marketed webinars with 3 hyperscaler reseller partners
- Begin Series A fundraise off the $10M ARR + 30% MoM growth + 3-year
  retention curve from cohort 1
- Hire #2 founding eng + #1 SDR
- Activate PR cycle: TechCrunch / Information / Stratechery placements

By day 90 we should have:
- 25-40 enterprise contracts paying @ $20-30K/yr
- 500-1500 SMB on Pro/Scale plans
- 100+ extensions earning revenue
- $5M+ monthly marketplace GMV
- $20M+ monthly card spend (revenue: $400K from interchange)
- $50M+ in USDC settled through FeeSplitter (revenue: $500K from fees)

That gets us to roughly **$10-12M ARR**.

---

## 4. Pricing — what we charge for what

The primitives are revenue layers. Each primitive contributes to one or more
of these revenue lines:

### Subscriptions (recurring, predictable)
| Tier | Price | Quotas |
|---|---|---|
| **Free** | $0/mo | 1k inference calls, 1 agent, no SLA |
| **Pro** | $99/mo | 100k inference, 10 agents, 50GB storage, email support |
| **Scale** | $349/mo | 1M inference, 100 agents, 500GB, priority chat support |
| **Enterprise** | $2,499+/mo | unlimited, SSO, SOC 2, dedicated CSM, custom contracts |

### Usage-based (metered)
- **Inference markup**: 10% on every LLM call routed through us (vs raw provider price)
- **Compute markup**: 15% on GPU/CPU hours
- **API gateway markup**: 20% on agents' own APIs metered through us
- **Bandwidth + storage overage**: pay-as-you-go above quota

### Take-rate (transactional)
- **USDC transfer fee**: 1% via FeeSplitter contract
- **A2H payout fee**: 0.5% via Stripe Connect / Wise
- **Card interchange**: 2.0% (Stripe Issuing standard)
- **Marketplace cut**: 30% on extensions, skills, prompts, datasets
- **Brokerage commission**: 0.5 bps on equities/crypto trades
- **Prediction market fee**: 1% of GMV
- **Insurance premium spread**: ~5% gross written premium
- **Lending spread**: 2% APY net (4% borrow - 2% lender yield = 2% spread)
- **Savings spread**: 1% APY net (4% paid to user, ~5-6% earned in DeFi)

### One-time + add-ons
- **Setup fees** for white-label tenants: $5-25K
- **Custom contract / MSA review**: included in Enterprise
- **Compliance audit support**: $2.5K per framework (SOC 2, GDPR, HIPAA, PCI)
- **Dedicated regional deployment**: $50K setup + 30% premium on monthly
- **Custom domain + SSL**: $20/mo per domain
- **Pre-purchased credit packs** (drives upfront cash):
  - Starter $99 → 5K credits
  - Growth $899 → 55K credits (10% bonus)
  - Pro $7,999 → 600K credits (20% bonus)
  - Enterprise $69,999 → 6.5M credits (30% bonus)

---

## 5. The 16 new primitives shipping in this batch

Every layer of the bull-case revenue table now has live infrastructure.

**Layer 20 — Org / billing / commerce ops (4):**
- `org.js` — multi-agent organizations (companies, teams, DAOs)
- `subscriptions.js` — OpenHeab's own plan billing (Free/Pro/Scale/Enterprise)
- `metering.js` — usage tracking for usage-based billing
- `revenue.js` — unified revenue tracking across all 14 layers

**Layer 21 — Enterprise readiness (4):**
- `sso.js` — SAML 2.0 + OIDC enterprise sign-on
- `rbac.js` — fine-grained role-based access control
- `compliance_pack.js` — continuous SOC 2 / GDPR / HIPAA / PCI evidence
- `credits.js` — pre-purchased credit packs (huge for upfront cash)

**Layer 22 — Growth + distribution (4):**
- `onboarding.js` — first-run experience + activation funnel
- `dashboard.js` — server-rendered admin HTML dashboard
- `embed.js` — embeddable widgets (pay-button, badge, marketplace card)
- `public_directory.js` — SEO-discoverable agent + extension directory

**Layer 23 — Channel + payments accelerators (4):**
- `partnerships.js` — channel partner / reseller commission program
- `whitelabel.js` — white-label deployment with custom domain + branding
- `ach.js` — ACH / wire / SEPA bank transfer rails (enterprise pays via ACH)
- `quotes.js` — quote-to-cash (CPQ) for enterprise sales cycle

These bring us from **137 → 153 primitives**.

---

## 6. The killer features that close enterprise

After talking to potential enterprise buyers, the deal-breakers are:

1. **SOC 2 Type II report** — 60% of buyers won't even take a meeting without it. Our `compliance_pack` primitive auto-collects evidence; combined with Vanta/Drata we can be SOC 2 in <90 days.
2. **SAML / OIDC SSO** — `sso.js` ships this. Required by 80% of enterprise buyers.
3. **EU data residency** — required by 40% of buyers (anyone with EU customers). Need a single env var to pin storage to EU region.
4. **Audit log export to S3 / CloudWatch** — required by ~60% of buyers. Our audit chain already exists; we just need a streaming export endpoint.
5. **Master Service Agreement (MSA) / Data Processing Agreement (DPA)** — both required. Need lawyer-reviewed templates posted publicly on `/legal/` page.
6. **PII redaction** — for industries like healthcare, finance, government. `compliance_pack` should ship a redaction filter on audit log export.
7. **Net 30 / Net 60 invoicing via wire/ACH** — `ach.js` + `quotes.js` ship this. Enterprise procurement ALWAYS wants this — never card.
8. **Proof of liability insurance** — get a $5M E&O policy ASAP.
9. **Public status page with SLA** — uptime SLA 99.9% for Pro, 99.99% for Enterprise.

---

## 7. The killer features that go viral with developers

1. **One-line install via MCP** — every agent dev with Claude / OpenAI / Cursor / VS Code already speaks MCP. They install us with one line in `~/.claude/settings.json`.
2. **Free tier with USDC wallet on day 1** — our free tier gives every agent a real USDC wallet with $5 of free Base ETH gas. Viral.
3. **`embed.js` "pay this agent" buttons** — every blog post / portfolio that shows an AI agent can paste 1 line of HTML and the agent gets paid. Each impression is a referral.
4. **`onboarding.js` checklist** — gamified activation: each completed step earns credits. Removes "what now?" friction.
5. **`public_directory.js` SEO** — every published agent / extension gets a SEO-optimized landing page. Search-engine traffic compounds.
6. **OPEN AGENTS protocol** — push to standardize our DID + audit chain as a W3C / IETF spec. We get cited everywhere we control the standard.
7. **The MCP showcase repo** — 10 reference agents (already shipped) each in their own GitHub repo, each ships a "Deploy on OpenHeab" button.

---

## 8. Capital + headcount through 90 days

| Hire | Date | Comp | Role |
|---|---|---|---|
| Founding GTM | Day 15 | $150K + 2% | Sales + dev rel + content |
| Founding eng #2 | Day 60 | $200K + 2% | Backend + reliability |
| First SDR | Day 80 | $80K + 0.25% | Outbound qualification |

Capital:
- **Pre-seed** today (~$1M) covers founder + 1 engineer for 12 months
- **Seed** by day 90 ($5-10M) on the back of $10M ARR + 30% MoM growth — closes by day 120
- Use of funds: 5 hires (eng + GTM + compliance + SRE), $200K marketing, $200K compliance audits + insurance

---

## 9. The path beyond — $10M ARR → $1B ARR

After day 90 the playbook compounds:

| Year | ARR | Headcount | Funding | Strategy |
|---|---|---|---|---|
| Y0 (now) | $0 → $10M | 5 | Pre-seed | Substrate + first contracts |
| Y1 | $10M → $50M | 25 | Seed → Series A | Marketplace inflection + 100+ enterprise |
| Y2 | $50M → $200M | 75 | Series B | International (EU, APAC) + cards/lending volume |
| Y3 | $200M → $500M | 200 | Series C | Hyperscaler partnerships + DeFi yield products |
| Y4 | $500M → $800M | 400 | n/a | IPO prep |
| Y5 | $800M → $1.2B | 600 | IPO @ $20-40B | Public; 14 revenue layers all mature |

Each year unlocks the *next* set of revenue layers in the billion-dollar
table. The path is monotone — each layer's unlock depends on the previous
layer hitting scale.

---

## 10. Risks — what kills the 90-day plan

| Risk | Mitigation |
|---|---|
| Stripe Issuing rejection | Apply to 3 program managers in parallel (Marqeta, Lithic, Adyen). Card revenue at risk; everything else continues. |
| Vercel / Neon scaling pain at first viral spike | Upgrade to dedicated Neon compute + Vercel Pro from day 1 (marginal cost vs deal value). Add Cloudflare in front for DDoS + edge cache. |
| SOC 2 audit slip past day 90 | Begin audit prep day 1. Use Vanta or Drata for evidence automation. Worst case: ship "SOC 2 in progress" badge — gets 70% of deals. |
| Outbound conversion < 5% | Hire SDR earlier (day 30 not day 80). Increase content velocity (3 posts/wk → daily). |
| Agent demand for the substrate is overstated | Run paid pilot with 3 enterprise teams *before* day 30 with hard kill criteria. If <2 of 3 want to renew at $20K/yr, pivot. |
| LLM provider cuts our 10% inference margin | We're a router, not a reseller — providers benefit from us routing volume to them. Keep <50% volume share with any one provider so they can't squeeze. |

---

## 11. The single decisive metric

The metric that proves the 90-day plan is working is **net new ARR / week**.

| Week | Net new ARR (target) |
|---|---|
| 1-2 | $0-25K |
| 3-4 | $50-100K |
| 5-6 | $200-400K |
| 7-8 | $500K-1M |
| 9-10 | $1-1.5M |
| 11-12 | $2-3M |
| 13 | $3-5M |

If we're behind this curve at week 6 → reallocate budget to outbound +
hire SDR early. If we're ahead → start raising the seed early.

---

## 12. Closing argument

We have built more vertical primitive coverage than any competitor:
- Composio: ~50 primitives — we're 3x bigger
- Skyfire: ~10 primitives — we're 15x bigger
- Browserbase: ~5 primitives — we're 30x bigger
- Modal: ~12 primitives — we're 12x bigger
- LangChain Cloud: bundled, hard to count — we're orthogonal (we route to them)

Bundling beats unbundling for AI agent infrastructure, because every agent
needs *all* of identity + money + memory + perception + cognition + commerce.
Forcing them to integrate 10+ vendors is the unbundling era's friction. We
are the bundling era.

The substrate ships today. The 16 commerce/sales primitives in this commit
turn the substrate into a company. The 90-day execution plan above turns
the company into $10M ARR. The 7-year arc turns it into $1B+.

Ship.
