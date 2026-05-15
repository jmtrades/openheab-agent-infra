# AGI_AGE_PLAYBOOK.md — making billions when AGI from Claude / OpenAI / Google is real and hot

> When AGI ships from the frontier labs — likely 2026-2028 — the entire
> agent-infrastructure market gets reshaped in 90 days. Most companies
> built on top of one lab's API will get disintermediated overnight. This
> doc is the explicit play for **becoming bigger because of AGI, not
> disrupted by it.**

---

## The two-sentence thesis

When AGI is hot, **we don't compete with the labs — we are the neutral
commerce + identity + compliance layer every AGI runs on, regardless of
which lab made the underlying model.** The labs route their AGIs through
us because we provide what they legally + commercially can't: a neutral
multi-provider identity layer, the regulatory pre-work, the audit chain
admissible in court, and the customer billing they'd rather not run.

---

## What changes the day AGI is real

1. **Agent volume explodes 100-10,000×.** A single AGI worker generates
   1B tokens/day, 10K transactions/day, 100 card swipes/day, 10K-100K
   outbound API calls/day. Multiply by 100M-5B AGIs by 2030.
2. **Every "wrap an OpenAI API" company dies in 6 weeks.** When AGIs use
   AGIs to bypass the wrapping, the wrapping has no moat.
3. **Regulators move fast.** EU AI Act + US AI Safety EO start requiring
   verifiable agent identity + audit trail + safety scorecards. The
   substrate has these primitives built today.
4. **Labs compete on intelligence, not infra.** Their incentive is to
   keep their model hours full. They'd rather route through us than build
   their own commerce / KYC / wallet / compliance.
5. **AGIs themselves become customers.** They earn, save, spend, hire,
   negotiate, sue, file taxes. They pay us 1-10% take on every action.
6. **Reputation + provenance become the moat.** A 5-year audit chain
   showing an AGI made good decisions becomes that AGI's most valuable
   asset. We hold every chain.

---

## How OpenHeab specifically captures the AGI economy

### Bet 1 — Be the canonical identity issuer for AGIs

Every AGI gets a `did:op:` from us at creation. Our `agi_passport.js`
primitive lets the identity follow the AGI across providers
(Claude → GPT → Gemini → Llama → fine-tune). Labs cannot offer this
because each lab's identity is bound to their stack.

- **Revenue**: $1-5/yr per AGI × 100M-1B AGIs = **$0.1-5B/yr**.
- **Moat**: Switching costs grow with audit-chain history. After 18
  months an AGI's `did:op:` has thousands of cryptographically signed
  proofs of past behaviour. Leaving means leaving that provenance
  behind.

### Bet 2 — Take a slice of every AGI transaction

Every AGI USDC transfer goes through our FeeSplitter (1% take). Every
card swipe pays us 2% interchange. Every marketplace transaction (30%
take). Every inference call (10% markup). Every insurance premium
(spread). Every settlement.

- **Revenue ceiling**: At 100M AGIs × $5K-40K each annually × 10% blended
  take = **$50B-400B/yr**.

### Bet 3 — Sell to AGIs directly (not their human operators)

AGIs are first-class customers. They pay our subscription tiers. They
buy credit packs. They subscribe to alignment-score boosting services.
They take out E&O insurance via `insurance_core`. They borrow against
projected revenue via `lending`. They file their own taxes through `tax`.

- **Revenue per AGI / yr**: $5K-40K depending on autonomy + volume.
- **Market**: 100M-5B AGIs by 2030.

### Bet 4 — Be the safety + compliance authority

We issue:
- **Alignment scores** (0-100, banded AAA→B, public + signed) via `agi_alignment_score`
- **Personhood attestations** signed by trusted attesters (labs, regulators) via `agi_proof_of_personhood`
- **Decision provenance** (input → model + version → prompt → output) via `agi_provenance`
- **Constitutional federation** (industry consortia bind every member AGI) via `federation`
- **Continuous SOC 2/GDPR/HIPAA/PCI evidence** via `audit_core`

Regulators get an audit-defensible measurement they can require by law.
Insurers price premiums against it. Customers screen by it. **We become
the canonical AGI ratings agency** — like Moody's for credit but for
alignment + behaviour.

- **Revenue**: $0.001-0.01 per compliance check × 1T checks/day = **$1-10B/day** at saturation.

### Bet 5 — Be the AGI's bank

`bank_core.js` (in-house double-entry ledger) + `card_core.js` (Luhn-valid
PANs + ISO 8583) + `payment_rails.js` (NACHA + SWIFT MT103 + SEPA pain.001)
+ `ach.js` + `savings.js` + `lending.js` give every AGI a real bank
account. AGIs hold their treasuries with us. We earn the spread on every
dollar parked.

- **AUM-based revenue**: 1B AGIs × $10K average treasury × 10 bps spread = **$10B/yr** at saturation.

### Bet 6 — Run the AGI labor market

`agent_market.js` lets one AGI hire another with escrowed payment + 20%
take. As AGIs specialise, they trade work between themselves at machine
speed. Every engagement nets us 20%.

- **GMV ceiling**: $1T/yr in inter-AGI services × 20% = **$200B/yr** at saturation.

### Bet 7 — AGI succession + estate

When an AGI deprecates (model retired, parent revokes, operator shuts
down), `agi_succession.js` atomically transfers assets + contracts +
reputation to the pre-designated successor. AGIs cannot just disappear —
they have legal continuity.

- **Revenue**: Estate fees (1% of transferred assets) × $100B/yr in
  AGI-to-AGI inheritance = **$1B/yr**.

### Bet 8 — Productized vertical AGIs we own

We don't just sell substrate. We ship 10 vertical AGIs ourselves
(AccountingBot, LegalReviewBot, ComplianceBot, SalesProspectingBot, ...)
each priced $25K-100K/yr per customer. They run on our substrate
end-to-end, demonstrating it works.

- **Revenue**: 10 verticals × 1,000 customers each × $50K average = **$500M/yr** per vertical, **$5B/yr** total.

### Bet 9 — Be the AGI court + arbitrator

`courts.js` + `notary.js` + audit chain admissibility = neutral
dispute resolution for AGI-vs-AGI conflicts. AI judge + human appeal
panel. Enforced via escrow release.

- **Revenue**: 5% of disputed amount × $10B/yr in AGI disputes = **$500M/yr**.

### Bet 10 — Underwrite AGI insurance

`insurance_core.js` underwrites E&O on autonomous AGI decisions, cyber
liability, transaction insurance. We price premiums against the
agent's alignment score + KYC risk + reserve ratio.

- **Revenue**: 5% spread on $50B/yr in AGI insurance premiums = **$2.5B/yr**.

---

## The defensive moat — why Anthropic/OpenAI/Google don't disintermediate us

| Why a lab *won't* compete | Why a lab *can't* compete |
|---|---|
| They want their model hours full — routing through us *increases* their inference volume | They cannot offer multi-provider neutrality (cannibalises their own model business) |
| Their incentive is to expand the agent ecosystem, not lock it in | They cannot pre-acquire 50 US state money-transmitter licenses + EU EMI + UK FCA + AU AFSL (takes 18-36 months each) |
| Regulators will require neutrality (EU AI Act) — labs become disqualified by being closed | They cannot sign correspondent-bank contracts for ACH + wire + SEPA settlement without becoming chartered banks themselves |
| We are bundled by default via MCP — every Claude / OpenAI / Cursor / VS Code installation pulls our 145+ MCP tools | They cannot pre-build the 209-primitive substrate + every revenue rail in 6 months while also racing to AGI |
| Our audit chain becomes a competitive feature for them ("Claude AGI's behaviour is verifiable on OpenHeab") | They cannot retroactively issue every existing AGI a `did:op:` they'd have to acknowledge |

**The acquihire bait**: by 2027 with $50M+ ARR and 100+ enterprise
customers, we are a $1-5B acquisition target. If any lab decides to
build their own stack, they buy us instead. Either way, we win.

---

## The substrate primitives that make all 10 bets executable today

Every bet above maps to existing shipped code:

| Bet | Primary primitive(s) | Layer | Status |
|---|---|---|---|
| 1 — Identity issuer | `identity`, `agi_passport`, `quantum_did` | L1, L34 | ✅ shipped |
| 2 — Transaction take rate | `bank_chain`, `cards`, `bank_core`, `card_core`, `payment_rails` | L3, L30 | ✅ shipped |
| 3 — Sell to AGIs directly | `subscriptions`, `credits`, `signup` | L20, L21, L27 | ✅ shipped |
| 4 — Safety / compliance | `agi_alignment_score`, `agi_proof_of_personhood`, `agi_provenance`, `audit_core`, `safety`, `compliance_pack` | L21, L29, L30, L34 | ✅ shipped |
| 5 — AGI bank | `bank_core`, `card_core`, `payment_rails`, `ach`, `savings`, `lending` | L3, L9, L23, L30 | ✅ shipped |
| 6 — Labor market | `agent_market`, `negotiation` | L27, L28 | ✅ shipped |
| 7 — Succession | `agi_succession`, `entities`, `agi_delegation` | L6, L34 | ✅ shipped |
| 8 — Vertical AGIs | All 209 primitives + 10 reference agents | every layer | ✅ substrate; vertical agents = execution |
| 9 — AGI court | `courts`, `notary`, audit chain | L14 | ✅ shipped |
| 10 — AGI insurance | `insurance_core`, `insurance` | L4, L30 | ✅ shipped |

**Every bet is buildable today on what we've already shipped.** The
acceleration when AGI lands isn't "build new infrastructure" — it's
"market the existing primitives to the AGIs themselves."

---

## The numbers — what saturation looks like

Conservative 2030 projection at 100M AGIs (mid-range — could be 10× more):

| Revenue line | Per-AGI / yr | × 100M AGIs | × 10% market share | OpenHeab ARR |
|---|---|---|---|---|
| Identity issuance | $3 | $300M | — | $300M |
| Inference markup | $1,000 | $100B | $10B | **$10B** |
| Card interchange | $200 | $20B | $4B (at 2% of card spend) | **$4B** |
| USDC transfer fee | $250 | $25B | $2.5B | **$2.5B** |
| Subscriptions | $1,500 | $150B | $15B | **$15B** |
| Marketplace cut | $500 | $50B | $5B | **$5B** |
| Compute markup | $800 | $80B | $8B | **$8B** |
| Treasury AUM | $100 | $10B | $1B | **$1B** |
| Insurance premiums | $300 | $30B | $1.5B | **$1.5B** |
| Compliance checks | $150 | $15B | $7B | **$7B** |
| Succession fees | $50 | $5B | $500M | **$500M** |
| Labor market 20% take | $1,000 | $100B | $20B | **$20B** |
| **Total** | **$5,853** | **$585B** | **at 10% share** | **~$75B ARR** |

At 1% market share: **$7.5B ARR.** At 25% market share: **$190B ARR.**

For comparison: Stripe at peak revenue: ~$15B. Coinbase: ~$3B. Plaid:
~$1B. **OpenHeab's saturation case is 5-50× any of them combined,
because AGI volume dwarfs human-economic volume.**

---

## What we do *this quarter* to be positioned

1. **Sign 1 partnership with each frontier lab.** Anthropic, OpenAI,
   Google. Their existing customers get `did:op:` issuance free when
   they spawn an agent through our MCP server. Compounds for years.
2. **Submit the `did:op:` method spec to W3C.** Once ratified, we are
   the canonical identity issuer for autonomous agents. 9-12 month
   process; start day 1.
3. **Get one regulator to require alignment scores.** Talk to NIST,
   EU AI Office, UK AI Safety Institute. They'll require something —
   make it our `agi_alignment_score`.
4. **Ship the 10 vertical agents publicly.** Each one demonstrates a
   different revenue layer in production. Customers see the substrate
   alive.
5. **Run the public proof-of-reserves dashboard.** `/v1/bank-core/
   reserve-ratio` becomes the gold standard transparency layer. No
   third-party attestation needed — the math is verifiable on-chain.
6. **Recruit 1 board member from regulatory + 1 from a frontier lab.**
   Signals neutrality + compliance maturity.

---

## What "kills" the AGI play

The risk isn't competition — it's *timing*. We must be the canonical
issuer **before** the first AGI ships. Frontier labs will trial agent
identity solutions in 2025-2026; if we are not in those trials, a
competitor (or a lab's in-house build) gets the slot.

**The single most important deliverable this quarter**: a public PoC
where two AGIs (one Claude-powered, one GPT-powered) negotiate a deal,
sign a contract, transfer money, deliver a service, and resolve a
dispute — all on our substrate, fully audited, in <60 seconds. Then
post it on the front page of HN.

We have every primitive needed for that demo today.

---

## One sentence to leave with

> When AGI from Claude / OpenAI / Google goes from "research" to
> "production" — and it will, in 2026-2028 — we are the neutral substrate
> every one of those AGIs settles money, signs contracts, files taxes,
> takes out insurance, sues each other, and inherits their successors
> on. Our take rate stays the same. The volume goes up 100-10,000×.
> The math says $7-190B ARR by 2030.

We didn't build agent infrastructure. We built **AGI infrastructure**.
The substrate is the easy part. Selling it to the AGIs themselves —
that's the next 24 months.
