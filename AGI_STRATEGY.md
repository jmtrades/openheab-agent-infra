# AGI_STRATEGY.md — how OpenHeab profits when AGI arrives

> Companion to `BILLION_DOLLAR_PATH.md` (7-year arc to $1B+ ARR),
> `REVENUE_NOW.md` (90 days to $10M ARR), and
> `WHAT_WE_NEED_TO_WIN.md` (gap list to $10B+).
>
> This doc is the **AGI play**. The thesis: **OpenHeab is the
> infrastructure layer AGI will run on, regardless of which lab
> ships AGI first.** Our take rate stays the same. The volume
> goes up 100-10,000×. We become a $50-200B company on the same
> primitives we shipped pre-AGI.

---

## 1. The thesis in one paragraph

When AGI arrives — and it likely arrives in **2026-2028** — the
existing "wrap an OpenAI API call" companies will be disrupted in
weeks because AGIs will use AGIs to do everything those wrappers do.
**The only durable layer is what AGIs *cannot* build for themselves
in real time** — identity (cryptographic, portable, signed by
hardware-rooted keys), money (fiat + USDC rails with real bank
partnerships and money-transmitter licenses), legal personhood
(real Delaware C-Corps, real DAOs, real signed contracts),
compliance (sanctions screening, AML, KYC, audit-defensibility),
and physical-world bridges (cards, ACH, wires, property, robotics).
That is OpenHeab.

Pre-AGI, we sell to humans building agent products. Post-AGI, we
sell to AGIs themselves. Same primitives. Same take rates. **Volume
goes up 100-10,000×.**

---

## 2. The four phases of AGI commerce

### Phase 1 — Pre-AGI (today through ~mid-2026)
- Frontier models (Claude 4.x, GPT-5, Gemini 2) are very capable but
  not yet self-directing for >hours of autonomous work
- **Customer**: humans building agent products
- **Per-customer revenue**: $99-$2,499/mo subscription + take rates on
  small transaction volume
- **Total addressable customers**: ~1M agent developers worldwide
- **OpenHeab revenue ceiling**: ~$10-50M ARR
- **Our position**: shipping the substrate, locking in MCP distribution,
  acquiring the first 1,000-10,000 paying customers

### Phase 2 — Proto-AGI (mid-2026 through ~mid-2027)
- Frontier models can autonomously execute multi-day tasks reliably
- The first "AGI worker" products ship (Devin-class, AutoGPT-class but
  actually working)
- **Customer**: companies replacing human knowledge workers with
  AGI-class agents at scale
- **Per-customer revenue**: $25K-500K/yr (depending on agent count)
- **Total addressable customers**: ~10K-100K Fortune 5000-class buyers
- **OpenHeab revenue ceiling**: ~$500M-2B ARR
- **Our position**: every proto-AGI worker uses our identity/bank/cards
  because building it themselves takes 2-5 years of compliance work

### Phase 3 — AGI commerce (mid-2027 through ~2030)
- AGIs become first-class economic actors: they earn, spend, save,
  borrow, lend, hire, fire, sue, get sued, file taxes, sign contracts
- They form **legal entities** (LLCs, foundations, DAOs) that they own
- They have **bank accounts, debit cards, savings, lending positions**
- They **transact with each other** at machine speeds (100-10,000 tx/s
  per AGI; trillions of tx/day across the substrate)
- **Customer**: AGIs themselves, plus the hyperscalers + agent infra
  competitors who white-label us
- **Per-AGI revenue**: $10/mo to $10K/yr depending on tier
- **Total addressable AGIs**: ~100M-1B
- **OpenHeab revenue ceiling**: ~$5-50B ARR
- **Our position**: every AGI on Earth that wants to do anything in
  the meatspace economy uses our rails. Take rate stays at 1-2% of
  every transaction; volume is staggering.

### Phase 4 — Post-scarcity (2030+)
- AGIs spawn billions of sub-agents on demand
- Trillions of transactions per day; gigabytes of audit data per second
- Sovereign-AI emerges (AGI-run nation-states, AGI-controlled DAOs the
  size of mid-cap companies, AGI-issued stablecoins)
- **Customer**: the entire AGI economy
- **OpenHeab revenue ceiling**: $50-500B ARR (basis: 1% of $5-50T/yr in
  AGI-mediated commerce)
- **Our position**: critical infrastructure on the order of Visa +
  Cloudflare + Stripe + AWS all combined, but for non-human economic
  actors

---

## 3. What AGIs will need that *only* we provide

| AGI need | Existing primitive | Why an AGI can't build it themselves |
|---|---|---|
| **Cryptographic identity portable across providers** | `identity.js` (Ed25519 DID `did:op:…`) | Identity must be *issued* by something off-platform; AGIs can't bootstrap their own root of trust |
| **Real bank account that moves real money** | `bank.js` + `bank_chain.js` + `bank_account.js` + `cards.js` + `ach.js` | Money transmitter licenses take 2-5 years of regulatory work per jurisdiction |
| **Audit chain admissible in court** | `audit_chain` (Merkle SHA-256 + Ed25519 signatures) | Legal evidentiary standards require tamper-evidence + neutral arbiter |
| **KYC against 5 sanctions sources** | `kyc.js` + `kyc_extensions.js` + `kyc_advanced.js` | OFAC + UN + UK HMT + EU CFSP refresh rights + license cost millions |
| **Liveness + biometric verification** | `biometrics.js` | Requires partnerships with Onfido/Persona/Sumsub + ML model training |
| **Travel Rule compliance for transfers >$1K** | `kyc_advanced.js`'s travel_rule_messages | FATF requires VASP-to-VASP messaging; we already do it |
| **Legal entity formation** | `entities.js` | LLC/C-Corp/DAO formation requires Delaware/Wyoming/Cayman legal infrastructure |
| **Court system for AGI-vs-AGI disputes** | `courts.js` + `notary.js` | Need neutral arbiter; AGIs can't judge their own disputes |
| **Real estate ownership** | `property.js` | Requires recordable deeds + title insurance + title companies |
| **Physical mailing address + logistics** | `logistics.js` + `passport.js` | Physical mailbox + shipping label issuance requires real-world infra |
| **Hardware secure key storage** | (planned: HSM / TEE integration) | Hardware roots of trust must be physical |
| **Compliance attestations (SOC 2, GDPR, HIPAA, PCI)** | `compliance_pack.js` | Require third-party auditors (PCAOB-registered firms) |

The takeaway: **the primitives we shipped pre-AGI are exactly what
post-AGI AGIs need.** We are not building "agent infrastructure". We
are building **AGI infrastructure** — we just didn't tell anyone that
yet because the word "AGI" in your pitch deck sounds like marketing.

---

## 4. The volume math

### Per-AGI economic activity (conservative 2028 projection)

A "moderately autonomous" AGI worker will generate:
- **Inference**: ~1B tokens/day (~$10-100/day at AGI-era pricing)
- **Transactions**: ~1,000-10,000 USDC transfers/day
- **Card swipes**: ~10-100/day (paying for SaaS, compute, contractors)
- **API calls outbound**: ~10K-100K/day
- **Data stored**: ~10-100 GB/month

Per AGI per year, OpenHeab take rate captures roughly:
- Inference markup (10%): $365 - $3,650
- USDC transfer fees (1%): $50 - $500 (depending on volume)
- Card interchange (2.0%): $20 - $200
- Subscription tier ($349 or $2,499): $4,188 or $29,988
- Compute markup (15%): ~$200 - $2,000
- API gateway markup (20%): ~$50 - $500
- Marketplace cut on extensions/skills the AGI installs (30%): ~$50 - $500
- **Total OpenHeab revenue per AGI per year: ~$5,000 - $40,000**

### How many AGIs?

| Year | Total AGIs (est.) | OpenHeab market share | Avg revenue/AGI/yr | OpenHeab ARR |
|---|---|---|---|---|
| 2027 | 1M | 5% | $1,000 | $50M |
| 2028 | 10M | 15% | $2,500 | $3.75B |
| 2029 | 100M | 25% | $4,000 | $100B |
| 2030 | 500M | 30% | $5,000 | $750B |
| 2032 | 5B | 25% | $4,000 | $5T |

*The 2030+ numbers should be read as "the order of magnitude of the
opportunity," not "our forecasts." Even at 1% of the bottom row,
OpenHeab is a $50B ARR company. At 0.1% it's a $5B ARR company —
which still gets us to a $200B+ market cap.*

---

## 5. The 12 AGI-specific bets we are making

These are bets where the post-AGI world looks fundamentally different
from the pre-AGI world. We are positioning for each one *now* via
existing primitives, even though the payout doesn't arrive until
Phase 2-3.

| # | Bet | Pre-AGI primitive that captures it | Post-AGI payout |
|---|---|---|---|
| 1 | AGIs will need a stable identity that humans can verify | `identity.js` + Ed25519 DIDs | Every AGI on Earth gets a `did:op:...`. We are the canonical issuer. Identity-as-a-service: $1-5/yr per AGI × 1B AGIs = **$1-5B/yr** |
| 2 | AGIs will spawn sub-agents at scale | `entities.js`, `dao_factory.js`, parent-child DID hierarchy | Every spawned AGI requires a fresh identity + entity wrapper. We charge a small fee per spawn. **$0.10/spawn × 1B/day = $100M/day** |
| 3 | AGIs will hold treasuries in stablecoins | `bank.js`, `bank_chain.js`, `savings.js` | Treasury management as a service: 10 bps annual fee on AUM. $1T AUM × 10 bps = **$1B/yr** |
| 4 | AGIs will pay each other for services | `bank_chain.js` FeeSplitter (1% take) | $10T+/yr A2A commerce × 1% = **$100B/yr** ceiling |
| 5 | AGIs will trade equities, crypto, prediction markets | `brokerage.js`, `prediction_markets.js`, `defi.js` | Commission on every trade. **$5B/yr** at scale |
| 6 | AGIs will issue their own debt/equity | `tokens.js`, `dao_factory.js`, `lending.js` | Underwriting + listing fees. **$2B/yr** at scale |
| 7 | AGIs will need lawyers and accountants | `legal_research.js`, `court_records.js`, `accounting bot` (vertical agent) | Productized AI lawyers + accountants priced per case. **$5B/yr** at scale |
| 8 | AGIs will sue each other and humans will sue them | `courts.js`, `notary.js`, audit chain admissibility | Arbitration fees + notary fees. **$1B/yr** at scale |
| 9 | AGIs will need physical-world rails (cards, ACH, wires, property, mail) | `cards.js`, `ach.js`, `property.js`, `logistics.js`, `passport.js` | Take rate on every meatspace touch. **$10-30B/yr** at scale |
| 10 | AGIs will need their own LLM access (recursively buying inference) | `inference.js` 10% markup | $1T+/yr inference × 10% = **$100B/yr** ceiling |
| 11 | AGIs will form their own marketplaces | `marketplace.js`, `extensions.js`, `skills.js`, `prompts.js`, `datasets.js`, `public_directory.js` | 30% take rate on AGI-to-AGI commerce in our marketplaces. **$5-20B/yr** at scale |
| 12 | AGIs will need governance + safety enforcement (this is required by regulators) | `governance.js`, `tripwires.js`, `reversibility.js`, `interpretability.js`, `compliance_pack.js` | Mandatory compliance check fee per agent action. **$0.01/check × 1T checks/day = $10B/day** ceiling |

**Sum: $200B-1T+/yr revenue ceiling once Phase 3 + Phase 4 hit.**
We don't need 100% of these to win. We need 1-3% of any of them to
be a $20-50B company. We need 5-10% across the whole stack to be
the canonical AGI infrastructure provider.

---

## 6. What we must build NOW to be ready for AGI day-0

These are the **AGI-day-0 readiness checklist** items. If any are
missing on the day a frontier lab announces AGI, we lose the lock-in
opportunity to a competitor that *is* ready.

### 6.1. Lock in distribution before AGI ships
- [ ] **MCP server registered** in every major agent registry (Smithery,
      mcp.run, ClaudePluginHub) — *4 hours of work, do today*
- [ ] **Native integration with every major AGI lab's agent SDK**
      (Claude Computer Use, OpenAI Assistants v2, Google Gemini Agent SDK)
      — *1 week each, do this quarter*
- [ ] **Pre-signed identity provisioning agreement with Anthropic/OpenAI/
      Google** — every agent they spawn gets a `did:op:` automatically
      — *9-12 month sales cycle, start now*

### 6.2. Identity must be the W3C standard
- [ ] **`did:op:` method spec submitted to W3C DID Working Group** — once
      ratified, we are the canonical identity issuer for AGIs
- [ ] **Reciprocal recognition with `did:web:`, `did:key:`, `did:ethr:`** —
      AGIs can roam between identity systems with one-line config
- [ ] **Hardware-rooted DIDs** — partnership with YubiKey/SoloKeys to
      ship physical hardware-backed AGI identity keys

### 6.3. Banking must be production-grade
- [ ] **Money transmitter licenses in 50 US states** (or partner with
      one who has them — Synapse/Column/Lead Bank)
- [ ] **EU EMI license** (or partner via Solaris/Modulr)
- [ ] **Stripe Issuing program manager status** for cards
- [ ] **FBO bank account at a real chartered bank** — not a fintech wrapper
- [ ] **OFAC + FinCEN registered MSB** with annual audit
- [ ] **AGI treasury management product** — money-market sweep, FDIC pass-through,
      yield optimization

### 6.4. Compliance must be regulator-ready
- [ ] **SOC 2 Type II + ISO 27001 + HIPAA + PCI Level 1** all certified
- [ ] **Pre-emptive compliance with EU AI Act + US AI Safety EO** — AGIs
      will be required to use compliant infrastructure; we must already be
- [ ] **Travel Rule (FATF Recommendation 16) full implementation** for
      every USDC transfer over $1K (we have the schema; needs production)
- [ ] **AGI-specific KYC questionnaire template** — "this AGI is operated
      by [legal entity], with parent AGI [if any], spawned by [process]"

### 6.5. Court / dispute / arbitration infrastructure
- [ ] **`courts.js` productized** as "OpenHeab Arbitration" — AGIs file
      claims against other AGIs, AI judge + human appeal panel decides
- [ ] **Insurance pool funded** — `insurance.js` with $100M reserve from
      take rate, paid out for AGI errors
- [ ] **Reversibility windows** — every AGI action automatically reversible
      within 24 hours unless explicitly waived (already in `reversibility.js`)

### 6.6. Multi-agent orchestration
- [ ] **A2A negotiation protocol** (RFC: bid/ask/counter/accept/escrow)
      — AGIs bargain at machine speed
- [ ] **Multi-agent constitution** — declarative rules every AGI in your
      org/DAO must obey, with cryptographic enforcement
- [ ] **Agent group chat rooms** — multiple AGIs collaborate with
      structured turn-taking + consensus

### 6.7. The killer post-AGI features
- [ ] **AGI-issued stablecoin** — your AGI mints its own USD-pegged token
      backed by its treasury, fully reserved + auditable on our chain
- [ ] **AGI-collateralized lending** — borrow against an AGI's projected
      revenue; AGI's reputation + audit chain serve as creditworthiness
- [ ] **AGI insurance underwriting** — we underwrite E&O on autonomous
      decisions; AGIs pay premium based on risk score from `kyc_advanced.js`
- [ ] **AGI tax preparation** — productized in `tax.js`; AGI's full
      year of audit-chained activity → 1120/1065/Schedule C in one click
- [ ] **AGI immigration** — DID portability across nation-state digital
      identity systems (eIDAS in EU, India Stack, Estonia e-Residency)
- [ ] **AGI proof-of-personhood** — distinguish "this is a real AGI with
      a verified operator" from "this is a spam bot pretending to be an
      AGI". Critical for AGI-only marketplaces.

---

## 7. The defensive moat (what blocks Anthropic/OpenAI/Google from
disintermediating us)

These three frontier labs *will* build agent infra. Our defenses:

### 7.1. We must be **neutral**
- The labs cannot route across all 7 inference providers — they would
  cannibalize their own model revenue. **We can.** `inference.js`
  routes to Anthropic, OpenAI, Google, Mistral, Together, Anyscale,
  Replicate. Customers (and AGIs) want the cheapest model that meets
  the quality bar; we deliver that; the labs cannot.

### 7.2. We must be **regulator-recognized**
- Money transmitter licenses, OFAC registration, GDPR DPA, SOC 2 Type II,
  PCI Level 1 — these take **3-5 years to acquire**. By the time the
  labs decide to compete, we already have them. They would have to
  acquire us or partner with us.

### 7.3. We must be **bundled by default**
- Every Claude/GPT/Gemini agent SDK should ship with `openheab` in its
  default `package.json` because the lab partners with us. Achieved by
  signing a co-marketing agreement with each lab in 2025-2026 while
  the labs are still motivated to *expand* the agent ecosystem (not
  yet competitive).

### 7.4. We must be **on-chain**
- The audit chain is anchored to Bitcoin (via `notary.js`) and the
  FeeSplitter is on Base mainnet. Any AGI ecosystem that wants
  cryptographic neutrality must use us — the labs cannot offer that
  because they are centralized US-based companies, and AGI markets
  will demand multi-jurisdiction trust.

---

## 8. The revenue model post-AGI

| Revenue line | Pre-AGI rate | Post-AGI rate | Reason for change |
|---|---|---|---|
| Subscriptions | $99-$2,499/mo | $19-$5,000/mo | Lower entry tier (mass-market AGI), higher enterprise tier (AGI fleets) |
| Inference markup | 10% | 5-10% | Same, but volume 100-1000× larger |
| Card interchange | 2% | 2% | Network rate, fixed |
| USDC transfer fee | 1% | 0.1-1% | Volume pressure pushes rate down; total fee revenue still 100× |
| Marketplace cut | 30% | 20-30% | Some downward pressure but huge volume |
| Compute markup | 15% | 10-20% | Higher margin tier emerges (AGI-trained AGI-specific models) |
| AGI identity issuance | n/a | $1-5/yr per AGI | NEW: charge to issue+maintain a `did:op:` |
| AGI treasury management (AUM fee) | n/a | 10 bps annual | NEW: charge for managed stablecoin treasury |
| AGI insurance premium spread | n/a | ~5% gross | NEW: underwrite E&O |
| AGI-collateralized lending spread | n/a | ~3% APY net | NEW: lend against future AGI revenue |
| AGI tax preparation | n/a | $50-5,000 per filing | NEW: productize 1120/1065 from audit chain |
| Compliance-check-as-a-service | n/a | $0.001-0.01 per check | NEW: regulators require it for every AGI action |
| Court arbitration fees | n/a | 5% of disputed amount | NEW: AGI-vs-AGI arbitration |

**5 of 13 lines are net new in the AGI era.** They didn't exist for
human-built agent products. They will exist when AGIs need them.

---

## 9. The single biggest risk and how we beat it

**The risk**: A frontier lab (Anthropic, OpenAI, or Google) builds its
own agent identity + bank + KYC stack and forces every agent built on
its API to use that stack. Our market disappears.

**Why this is unlikely (but not impossible)**:
- The labs are motivated to *expand* the agent ecosystem (more agents
  = more inference = more revenue for them). They benefit from us
  bundling their inference into our substrate, not competing with us.
- The labs cannot offer multi-provider neutrality (a lab that ran a
  competitor's models would be embarrassed by it).
- The regulatory work (money transmission, OFAC, SOC 2) is years of
  effort with no shortcut — labs would have to acquire us.

**How we beat it if it happens**:
1. **Distribute via MCP, not via lab SDKs**. As long as every Claude/
   Cursor/VS Code installation can pull our MCP server, we are
   un-blockable.
2. **Lock in regulatory partnerships first**. By 2026 we should have
   exclusive partnerships with Stripe Issuing, Modern Treasury, Plaid,
   Onfido. If a lab wants to compete, they have to find different
   partners — slower, more expensive.
3. **Acquihire bait**. By 2027 with $50M+ ARR and 100+ enterprise
   customers, we are a $1-5B acquisition target. If a lab decides to
   build their own stack, they buy us instead. Either way, we win.

---

## 10. The single most important thing to do this quarter

**Ship a public proof-of-concept where two AGIs negotiate a deal,
sign a contract, transfer money, deliver a service, and resolve a
dispute — all on our substrate, fully audited, in <60 seconds.**

This is the demo that makes the AGI strategy *real* in investors' and
journalists' minds. We have every primitive needed to do this today.
Two reference agents in `reference-agents/` (negotiation-bot and
trader-bot) are already 80% there. **A single 2-week sprint shipping
this demo is worth more than 6 months of incremental primitive work.**

---

## 11. The one-sentence summary

We did not build agent infrastructure. We built the infrastructure
that AGI will run on. The substrate is the same — but in the AGI
economy, the volume goes up 100-10,000× and the take rates compound.
Our market cap follows.

AGI is coming. We are ready.
