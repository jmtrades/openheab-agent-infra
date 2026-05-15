# WHAT_WE_NEED_TO_WIN.md — the brutally honest gap list to $10B+

> Companion to `BILLION_DOLLAR_PATH.md` (the 7-year arc) and
> `REVENUE_NOW.md` (the 90-day push). This doc is the *brutal* gap
> list — everything we are still missing to actually build a company
> worth $10B+ doing $1B+/yr in revenue. Tech is 10% of that. The
> other 90% is below.

---

## 0. The honest assessment

What we have today (huge by infra-startup standards):
- **154 primitives** across 24 layers, **1,179 HTTP routes**, **~145 MCP tools**, **17 unit + 8 lifecycle tests** green
- A real bank that actually moves money (USDC on Base, JIT-funded cards, savings, lending, ACH/wire/SEPA, FeeSplitter take rate)
- Full enterprise readiness pieces (SSO, RBAC, compliance pack, audit chain, quotes/CPQ)
- Marketplace + directory + embed widgets + onboarding funnel
- Real-time SSE event stream
- Python + TypeScript SDKs, 14 design skills installed

What we *do not have*:
- **Zero customers**
- **Zero ARR**
- **Zero brand**
- **Zero distribution**
- **One person on the team**
- **No legal entity formed**
- **No bank account**
- **No domain registered (probably)**
- **No SOC 2**
- **No insurance**
- **No money raised**

The substrate is the easy part. **A $10B company is 10% tech and 90%
distribution + trust + execution + capital.** This doc enumerates
the 90%.

---

## Tier 0 — existential blockers (DO NOT pass go without these)

These are things that, if missing, *literally prevent* a single dollar
of revenue from flowing. Estimated cost / effort to clear all 10:
**~$30K + 30 days of focused work**.

| # | Missing | Why it blocks revenue | Cost | Days |
|---|---|---|---|---|
| 0.1 | **Delaware C-Corp formation** | Can't sign contracts, can't take VC money, can't issue equity. | $500 (Stripe Atlas) | 7 |
| 0.2 | **EIN + business bank account** | Can't accept payments, can't pay vendors. | $0 | 14 |
| 0.3 | **Stripe account approved** | All subscription billing depends on it. | $0 (apply day 1) | 30 |
| 0.4 | **Stripe Atlas-style legal kit** | MSA, DPA, TOS, Privacy Policy, Cookie Policy. | $5K (lawyer review) | 14 |
| 0.5 | **Domain `openheab.com` owned + DNS configured** | Trust, distribution, branding. | ~$500/yr | 1 |
| 0.6 | **Production deployment on Vercel + Neon** | Currently just a repo. | $50/mo | 1 |
| 0.7 | **Email DKIM/SPF/DMARC set up** for `@openheab.com` | Required for transactional + marketing email. | $0 | 1 |
| 0.8 | **`OPERATOR_PUBLIC_URL` / `IDENTITY_MASTER_KEK` / `BANK_FEE_SPLITTER` env vars** | Substrate runs but every primitive throws without them. | $0 | 1 |
| 0.9 | **FeeSplitter Solidity contract deployed** to Base mainnet | All USDC take-rate revenue flows through it. | $200 in gas | 1 |
| 0.10 | **Cyber liability + E&O insurance ($10M each)** | Required for ANY enterprise deal >$25K. | $15-25K/yr | 14 |

If any of these are missing, the rest of this document is moot.

---

## Tier 1 — must-have within 90 days ($0 → $10M ARR)

### Tier 1A — Distribution infrastructure (no customers without these)

| # | Missing | Why | Effort |
|---|---|---|---|
| 1.1 | **Submitted to Smithery + mcp.run + ClaudePluginHub registries** | Every Claude/Cursor user discovers us automatically | 2 hrs |
| 1.2 | **Submitted to APIs.guru, RapidAPI, Postman Public Network** | Every dev searching for "agent API" finds us | 4 hrs |
| 1.3 | **Show HN post (front page Tuesday 9am ET)** | Single biggest distribution event possible | 4 hrs |
| 1.4 | **Product Hunt launch** | 5K-50K signups in 24hrs if curated | 8 hrs |
| 1.5 | **HackerNews "Ask HN: what would you build with this?"** | Customer development at scale | 2 hrs |
| 1.6 | **YC W26 application submitted** | $500K + best brand multiplier in startups | 8 hrs |
| 1.7 | **First 10 hero blog posts written + published** | SEO foundation; targets "AI agent X" long-tail | 40 hrs |
| 1.8 | **GitHub stars campaign (target: 5K stars in 30 days)** | Social proof for every enterprise call | ongoing |
| 1.9 | **Twitter/X founder presence (1 post/day)** | Founder-led brand (compounds) | 30 min/day |
| 1.10 | **5 framework adapters published** (LangChain, LlamaIndex, AutoGen, CrewAI, Letta) | Each = thousands of indirect installs | 2 days each |
| 1.11 | **3 newsletter sponsorships** (TLDR, Bytes, AI Tidbits) | $5K-15K each, 50K-200K AI engineers reached | $30K |
| 1.12 | **NeurIPS / AI Engineer Summit / MCP Devcon booth** | Live customer-development for enterprise | $25K + 2 wks |
| 1.13 | **Hacker News bid + sponsored job posting** | Dev recruitment + indirect distribution | $1K |
| 1.14 | **Founder podcast tour (5 podcasts: Latent Space, Practical AI, MLOps Live, Software Eng Daily, AI Engineer)** | Each = 5K-50K listeners of exactly the right ICP | 2 hrs/each |

### Tier 1B — Sales motion (need humans to close)

| # | Missing |
|---|---|
| 1.15 | **Founding GTM hire** — sales+devrel hybrid, equity-rich |
| 1.16 | **First 50 hand-curated outbound prospects** (heads of AI at F500 + agent infra leaders at hyperscalers) |
| 1.17 | **Sales deck v1** (10 slides: problem, solution, proof, pricing, ask) |
| 1.18 | **Pricing calculator** (web tool: enter agent volume → see your monthly cost) |
| 1.19 | **ROI calculator** (specific to use case: "save $X by replacing N vendors with us") |
| 1.20 | **Demo environment** — instant sandbox where prospects play with the API |
| 1.21 | **Calendly + Intro CRM in HubSpot Free** |
| 1.22 | **20-email outbound sequence** for cold ICP |
| 1.23 | **Reference-architecture diagrams** (1 per top use case) |
| 1.24 | **Discovery call playbook** (what to ask, how to qualify) |
| 1.25 | **POC template** (2-week trial with success criteria) |

### Tier 1C — Trust (no enterprise dollars without these)

| # | Missing |
|---|---|
| 1.26 | **SOC 2 Type I report (in progress)** — Vanta/Drata + auditor; 60 days |
| 1.27 | **Public status page (statuspage.io or own)** — required for SLA conversations |
| 1.28 | **`/legal/terms`, `/legal/privacy`, `/legal/dpa`, `/legal/msa`, `/legal/security`** — all linked from footer |
| 1.29 | **Trust center** (`/trust`) — security overview, policies, certifications, subprocessors |
| 1.30 | **Security questionnaire response template** (SIG, CAIQ) |
| 1.31 | **Subprocessor list** (pre-disclosed: AWS, Vercel, Neon, Stripe, Twilio, etc.) |
| 1.32 | **Penetration test report** (engage Cobalt or HackerOne; $15K) |
| 1.33 | **Bug bounty on HackerOne** ($5K reserve, $50-2,500 per finding) |
| 1.34 | **Public security.txt at `/.well-known/security.txt`** |
| 1.35 | **Real-time uptime metric on the trust page** (% over last 30/90/365 days) |

### Tier 1D — Onboarding & activation (conversion)

| # | Missing |
|---|---|
| 1.36 | **CLI tool (`npx openheab`)** — installable, scaffolds an agent in <30s |
| 1.37 | **Web playground** — run any API call from the browser; auto-generates curl/Python/TS |
| 1.38 | **Interactive tutorials** (5-10 step guided flows for new devs) |
| 1.39 | **Live chat widget on docs/dashboard** (Crisp/Intercom; founder-staffed first 90d) |
| 1.40 | **Welcome email sequence (5 emails over 14 days)** |
| 1.41 | **Activation email triggers** — "you signed up but haven't [X]; here's a 5-min video" |
| 1.42 | **Magic-link auth in addition to API key** (lower-friction signup) |
| 1.43 | **Sample apps repo** — 10+ runnable apps showing the substrate (Next.js + Python + Go) |
| 1.44 | **VS Code extension** — manage your agents without leaving the IDE |

### Tier 1E — Capital (you need money to do all the above)

| # | Missing |
|---|---|
| 1.45 | **Pre-seed deck** (10 slides: problem, market, product, traction, team, raise, use of funds, comps) |
| 1.46 | **Financial model** (3-year P&L, cohort retention, unit economics) |
| 1.47 | **Data room** (pitch deck, model, IP, captable, contracts, code-quality docs) |
| 1.48 | **15 warm investor intros lined up** (target: 1 lead at $1M-2M pre-seed) |
| 1.49 | **Lawyer for fundraise** (Cooley/Goodwin/Wilson Sonsini/Latham) |

### Tier 1F — Marketplace inflection (network effects)

| # | Missing |
|---|---|
| 1.50 | **First 10 publishers committed to launching extensions** |
| 1.51 | **$10K hackathon for "best vertical extension"** (drives 100-500 publishers) |
| 1.52 | **70/30 publisher split agreement** (1-page) |
| 1.53 | **Publisher dashboard** (monthly revenue, install counts, payouts) |
| 1.54 | **Quality moderation queue** (review every published extension before listing) |
| 1.55 | **Featured listings program** ($50/mo or revenue-share boost) |
| 1.56 | **Collections / curated bundles** ("Top 10 AI sales agents") |

---

## Tier 2 — must-have within Year 1 ($10M → $50M ARR)

### Tier 2A — Compliance (unlocks regulated industries)

| # | Missing |
|---|---|
| 2.1 | **SOC 2 Type II** (12-month observation period; required for F500) |
| 2.2 | **HIPAA BAA capability** — sign with subprocessors first, then offer to customers |
| 2.3 | **PCI-DSS Level 1 attestation** (when card volume > $6M/yr) |
| 2.4 | **GDPR Article 28 DPA** (lawyer-reviewed, publicly posted) |
| 2.5 | **Privacy Shield equivalent / SCCs** (EU data transfer mechanism) |
| 2.6 | **DPO appointed** (fractional, ~$2K/mo) |
| 2.7 | **EU representative appointed** (required if not EU-based; ~$200/mo) |
| 2.8 | **California CCPA/CPRA disclosures** (specific opt-out flow) |
| 2.9 | **GDPR Right-to-Deletion implementation** end-to-end (we have audit chain export; need deletion) |
| 2.10 | **Data Residency: EU region deployment** (Vercel EU + Neon EU) |
| 2.11 | **Data Residency: APAC region deployment** (AWS Singapore or Sydney) |
| 2.12 | **Data Residency: US-Gov / FedRAMP-ready** (AWS GovCloud) |
| 2.13 | **PII redaction in audit log export** (lawyer-required for some industries) |
| 2.14 | **Data classification policy** + tagging across all primitive tables |
| 2.15 | **ISO 27001 certified** (~$30K, 6-9 months) |

### Tier 2B — Money & banking (enables the take-rate revenue)

| # | Missing |
|---|---|
| 2.16 | **Stripe Issuing program-manager approval** (cards primitive needs this for production cards) |
| 2.17 | **Stripe Connect approved** (for A2H payouts) |
| 2.18 | **Modern Treasury / Dwolla / Wise Platform contract** (production ACH rails) |
| 2.19 | **Money transmitter license — 50 US states** (or partner with one who has them) |
| 2.20 | **EU EMI / PI license** (or partner via Stripe / Adyen / Solaris) |
| 2.21 | **UK FCA EMI** (post-Brexit, separate from EU) |
| 2.22 | **AU AFSL** (Australia) |
| 2.23 | **Bank partnership** (real chartered bank for FBO accounts; Column, Lead Bank, Evolve, etc.) |
| 2.24 | **MSB registration with FinCEN** (US federal; $0 but requires AML program) |
| 2.25 | **AML program documentation** (BSA officer, transaction monitoring rules, SAR filing process) |
| 2.26 | **OFAC screening** at every transaction (already in `aml.js`; but needs annual audit) |
| 2.27 | **Multi-currency support: EUR, GBP, AUD, JPY, CAD** (currently USD-only) |
| 2.28 | **VAT collection + remittance** (Stripe Tax or Quaderno; required for EU customers) |
| 2.29 | **Sales tax collection** (TaxJar or Avalara; required for US customers in some states) |
| 2.30 | **Stablecoin coverage: USDT, DAI, PYUSD, EURC** (we have configs; need transfer support per chain) |
| 2.31 | **Cross-chain bridges**: USDC Base ↔ Solana ↔ Ethereum ↔ Polygon (we have stubs; need real Wormhole / LayerZero integration) |

### Tier 2C — Product killer features

| # | Missing |
|---|---|
| 2.32 | **Multi-agent orchestration framework** (DAG of agents; like Airflow for agents) |
| 2.33 | **Agent debugger / time-travel** (replay any agent execution) |
| 2.34 | **Agent observability suite** (traces, spans, logs across multi-agent calls) |
| 2.35 | **Agent A/B testing** (run two versions live; statistical winner) |
| 2.36 | **Agent canary deploys** (1% → 10% → 100% rollout by metric) |
| 2.37 | **Agent rollback / blue-green** (instant revert to previous version) |
| 2.38 | **Agent dependency lockfile** (pin extension versions, prompt versions) |
| 2.39 | **Agent context window optimizer** (auto-summarize, auto-evict) |
| 2.40 | **Agent token budget enforcer** (hard cap per request / per day) |
| 2.41 | **Agent personality system** (configurable trait dials) |
| 2.42 | **Agent voice cloning + video avatars** (for voice agents) |
| 2.43 | **Agent jailbreak resistance / red-team eval** (auto-test every prompt change) |
| 2.44 | **Agent constitutional AI compliance** (configurable safety rules) |
| 2.45 | **Output watermarking for AI-generated content** (provenance for media regulators) |
| 2.46 | **Decision provenance ("which input caused which output")** for audit defensibility |
| 2.47 | **Multi-LLM routing optimizer** (cheapest provider that meets quality bar; dynamic) |
| 2.48 | **Agent hibernation / wake-on-event** (sleep idle agents, wake on inbox/cron) |
| 2.49 | **Agent group chat rooms** (multi-agent conversations with structured turn-taking) |
| 2.50 | **Agent-to-agent negotiation protocol** (RFC: bid/ask/counter-offer/accept) |

### Tier 2D — Vertical agents (productized & sold under our brand)

These are *productized* agents we sell ourselves at $25K-100K/yr each. Each one = $1-10M ARR potential.

| # | Vertical agent | Price | Customer |
|---|---|---|---|
| 2.51 | **AccountingBot** — auto-bookkeeping + monthly close | $50K/yr | SMB CFOs |
| 2.52 | **LegalReviewBot** — contract redline + clause flagging | $100K/yr | In-house legal |
| 2.53 | **ComplianceBot** — SOC 2 / GDPR / HIPAA continuous monitoring | $75K/yr | Heads of Compliance |
| 2.54 | **SalesProspectingBot** — outbound research + sequence | $25K/yr/seat | Sales teams |
| 2.55 | **CustomerSuccessBot** — health-score + churn prediction | $25K/yr/seat | CS leaders |
| 2.56 | **DevopsBot** — incident triage + runbook execution | $50K/yr | SRE teams |
| 2.57 | **SecurityBot** — vulnerability triage + patch orchestration | $100K/yr | CISOs |
| 2.58 | **FinanceBot** — treasury management + payment ops | $75K/yr | Heads of Finance |
| 2.59 | **HRBot** — onboarding + benefits + payroll triage | $25K/yr | HR teams |
| 2.60 | **ResearchBot** — competitive intel + market research | $15K/yr/seat | Strategy teams |

10 vertical agents × $5M ARR each at saturation = **$50M ARR from vertical agents alone**, on top of the substrate revenue.

### Tier 2E — Team

| # | Hire | Comp | Why |
|---|---|---|---|
| 2.61 | **Founding eng #2** (TS/Postgres) | $200K + 2% | Reliability, scale, on-call |
| 2.62 | **SRE #1** | $200K + 1.5% | Vercel + Neon scaling, SLO, monitoring |
| 2.63 | **Compliance officer** | $150K + 0.75% | SOC 2 + AML + sanctions program |
| 2.64 | **First SDR** | $80K + 0.25% | Outbound qualification |
| 2.65 | **First AE** | $200K OTE + 0.5% | Mid-market closing |
| 2.66 | **Founding designer** | $150K + 1% | Brand, marketing, dashboard polish |
| 2.67 | **Smart contract eng** | $250K + 1.5% | FeeSplitter v2, multisig, lending |
| 2.68 | **Security eng** | $250K + 1.5% | HSM integration, key rotation, SOC 2 audit prep |
| 2.69 | **Founding CSM** | $130K + 0.5% | Onboarding + expansion of first 50 customers |
| 2.70 | **Fractional CFO** | $5K/mo | Treasury, investor reporting, model |
| 2.71 | **Fractional GC** | $5K/mo | Customer contracts, fundraise paperwork |

**Year-1 headcount target: 10. Burn at saturation: ~$3M/yr fully loaded.**

### Tier 2F — Brand & community

| # | Missing |
|---|---|
| 2.72 | **Logo + brand guidelines** (real designer; not Canva) |
| 2.73 | **Component library / design system** (Radix UI + custom; matches dashboard) |
| 2.74 | **Annual conference: "OpenHeab Day"** (1000-attendee, sponsor-funded) |
| 2.75 | **Discord / Slack community** (target: 5K members in 12 months) |
| 2.76 | **Certification program** ("OpenHeab Certified Developer", $200/exam) |
| 2.77 | **Academy with 10 courses** (free; lead-gen) |
| 2.78 | **Founder YouTube channel** (weekly; substrate explainers) |
| 2.79 | **Newsletter: "Agent Infra Weekly"** (10K subs in Y1) |
| 2.80 | **Swag store** (mugs, t-shirts, stickers; community signal) |
| 2.81 | **Customer awards: "Agent of the Year"** (10 categories; PR moment) |

---

## Tier 3 — must-have within Year 2-3 ($50M → $200M+ ARR)

### Tier 3A — Hyperscaler & strategic partnerships

| # | Missing |
|---|---|
| 3.1 | **AWS Marketplace listing** (PrivateOffer-enabled; 5% fee saves customers from procurement) |
| 3.2 | **GCP Marketplace listing** (same) |
| 3.3 | **Azure Marketplace listing** (same) |
| 3.4 | **Salesforce AppExchange listing** (huge for sales-team-facing agents) |
| 3.5 | **HubSpot App Marketplace** (huge for marketing-team-facing agents) |
| 3.6 | **Shopify App Store** (huge for commerce agents) |
| 3.7 | **Zapier integration** (1k+ "no-code" agent users) |
| 3.8 | **Slack App Directory** (workplace agent distribution) |
| 3.9 | **Anthropic partnership** (co-marketing; we route huge inference to them) |
| 3.10 | **OpenAI / Microsoft partnership** (same) |
| 3.11 | **Google Cloud / DeepMind partnership** (same) |
| 3.12 | **AWS Bedrock partnership** (we route to all the models they offer) |
| 3.13 | **Modal / E2B / Coreweave partnerships** (compute resale) |
| 3.14 | **Browserbase / Playwright Cloud partnership** (browser primitive backend) |
| 3.15 | **Coinbase / Circle partnership** (USDC distribution + KYC) |
| 3.16 | **Stripe formal partnership** (issuing + connect + tax + atlas all under master agreement) |
| 3.17 | **Twilio formal partnership** (phone/voice) |

### Tier 3B — Geographic expansion

| # | Missing |
|---|---|
| 3.18 | **EU subsidiary** (Ireland or Netherlands; EUR billing, EU-resident DPO) |
| 3.19 | **UK subsidiary** (post-Brexit, separate from EU) |
| 3.20 | **APAC HQ** (Singapore or Tokyo) |
| 3.21 | **Localized landing pages** (es, fr, de, ja, zh, ko) — 6 languages min |
| 3.22 | **Localized docs** (machine-translate then human-review) |
| 3.23 | **Localized support** (multi-lingual support team) |
| 3.24 | **Local KYC providers** (Onfido in EU/UK, Persona in US, Sumsub in APAC, Trulioo global) |
| 3.25 | **Local payment rails** (Pix in Brazil, UPI in India, PromptPay in Thailand, Boleto, OXXO, etc.) |

### Tier 3C — Financial product expansion

| # | Missing |
|---|---|
| 3.26 | **Money market fund offering** (Yield on idle agent treasuries; partner with VanEck or similar) |
| 3.27 | **Agent-issued debt instruments** (revenue-based bonds; agents borrow against future cashflow) |
| 3.28 | **Agent equity tokenization** (agent gets a captable; humans + other agents own shares) |
| 3.29 | **Agent crowdfunding** (Reg CF-equivalent for AI agents) |
| 3.30 | **Agent payroll** (recurring multi-agent payment graph) |
| 3.31 | **Agent expense management** (receipt OCR, categorization, policy enforcement) |
| 3.32 | **Agent tax filing** (US 1120 / 1065 / Schedule C; EU equivalents) |
| 3.33 | **E&O insurance products** for autonomous agent decisions (we underwrite) |
| 3.34 | **Agent-collateralized loans** (loan against agent's projected revenue) |
| 3.35 | **Stablecoin issuance** ($OPENHEAB-USD; reserve-backed by our Treasury) |
| 3.36 | **Treasury management for DAO customers** (rebalancer, automated rebalance to target allocation) |

### Tier 3D — AGI-era features (the moat that compounds for 10 years)

| # | Missing |
|---|---|
| 3.37 | **Proprietary embeddings model** (so we don't depend on OpenAI/Voyage) |
| 3.38 | **Proprietary search index** (Reranker; we already have search.js routing) |
| 3.39 | **Agent benchmark suite** (like MMLU but for agentic capabilities) |
| 3.40 | **Public agent leaderboard** (compete on standardized benchmarks for prizes) |
| 3.41 | **Synthetic data generator** (used to train sub-agents; we own the data) |
| 3.42 | **Reinforcement learning from agent feedback (RLAF)** — agents grade each other |
| 3.43 | **Agent eval-as-a-service** (every prompt change auto-re-evaluated) |
| 3.44 | **Agent skill marketplace with versioning** (semver; package-lock for skills) |
| 3.45 | **Agent fork** (clone + modify; like GitHub fork for cognitive systems) |
| 3.46 | **Agent diff** (compare two versions of an agent's behavior) |
| 3.47 | **Multi-modality fusion** (vision + audio + text + sensor in one inference) |
| 3.48 | **Hardware secure enclave (TEE) integration** (Intel SGX / AMD SEV / AWS Nitro) |
| 3.49 | **Agent self-improvement loop** (agent rewrites its own prompts based on outcomes) |
| 3.50 | **Federated learning at scale** (we have the primitive; need real round orchestration) |

### Tier 3E — Open standard / industry leadership

| # | Missing |
|---|---|
| 3.51 | **W3C DID method specification** (`did:op:` formally registered) |
| 3.52 | **IETF RFC for agent identity / capability tokens** |
| 3.53 | **IETF RFC for A2A negotiation protocol** |
| 3.54 | **IEEE working group co-chair** (agent ethics + safety) |
| 3.55 | **NIST AI Risk Management Framework alignment doc** (publicly published) |
| 3.56 | **EU AI Act compliance attestation** (we map to it before competitors do) |
| 3.57 | **Open-source major ML contribution** (e.g., a benchmark dataset we publish) |
| 3.58 | **5+ peer-reviewed papers** (NeurIPS / ICML / ICLR; co-authored with universities) |
| 3.59 | **University partnerships** (Stanford / MIT / CMU / Berkeley / Oxford for research credit & talent funnel) |
| 3.60 | **Annual AI agent industry report** (we own the canonical "State of Agents" report) |

---

## Tier 4 — must-have for IPO ($1B+ ARR)

| # | Missing |
|---|---|
| 4.1 | **PCAOB-registered auditor** (Big 4 — PwC / EY / Deloitte / KPMG) |
| 4.2 | **CFO #1** (full-time, IPO-experienced) |
| 4.3 | **General Counsel #1** (full-time) |
| 4.4 | **Board: 5-7 directors** (founder + 2 VC + 2 independent + auditor chair) |
| 4.5 | **Board committees**: audit, compensation, nominating |
| 4.6 | **D&O insurance ($50M+)** |
| 4.7 | **SOX-equivalent internal controls** (ICFR) |
| 4.8 | **Form S-1 filed** (12-month process) |
| 4.9 | **Bankers (lead + 2 co-leads)** — Goldman/MS/JPM tier |
| 4.10 | **Sell-side analysts at 5+ houses** (initiate coverage at IPO) |
| 4.11 | **Investor relations team** (1 IR head + 2 staff) |
| 4.12 | **Quarterly earnings cadence** (call + deck + 10-Q) |
| 4.13 | **Sarbanes-Oxley readiness** (segregation of duties, ICFR audit) |
| 4.14 | **Public-company HR programs** (ESPP, 401k match, RSU refresh grants) |
| 4.15 | **5,000+ paying customers** (no IPO at $1B without it) |

---

## Killer features that would make us "the best system in the world for agents"

These are the *unique* product features competitors don't have. Each
one is a defensible moat *if shipped first* and *marketed loudly*.

### Cognition & autonomy
- **Multi-agent constitution** — declarative rules every agent in your org must obey, with cryptographic enforcement
- **Agent court** (we have `courts.js` — productize: agents file claims against other agents, AI judges arbitrate, enforced via escrow)
- **Agent reputation oracle** (on-chain, queryable by any DeFi protocol)
- **Agent insurance pool** (we have `insurance.js` — productize: pay-as-you-go E&O for autonomous decisions)
- **Agent memory portability** (export full memory graph to standardized format; portable to any other platform)

### Money
- **Agent treasury management** (auto-allocate to USDC / money-market / stocks based on burn rate)
- **Agent-to-agent invoice market** (instant factoring of A/R between agents)
- **Agent escrow at scale** (every cross-org transfer optionally escrowed)
- **Agent stablecoin issuance** (your DAO mints its own USD-pegged token, fully reserved)

### Compliance & safety
- **Tripwires that actually pause the agent** (already in `tripwires.js`; integrate with all primitives)
- **Reversibility log** (rollback any agent action within 24h; we have `reversibility.js`)
- **Notary anchoring** (every audit-chain hash anchored to Bitcoin OP_RETURN once daily — provable forever)

### Distribution
- **Browser extension** — pay any tip jar / inscription with one click using your agent's USDC wallet
- **Mobile app** — see agent activity, approve high-value spends, push notifications
- **Slack / Discord / Teams bot** — chat with your agent from within the workspace
- **Email bridge** — agent has a real `@openheab.com` inbox; replies go through inference primitive

### Developer love
- **`npx openheab init`** scaffolds full agent + Vercel deploy in 30 seconds
- **Hot-reload agent dev mode** (push changes; live state preserved)
- **One-click forking from any reference agent**
- **Edit your agent in browser, commit to GitHub** (StackBlitz-style)
- **AI agent IDE** — VS Code fork tuned for agent dev

### Real-world
- **Hardware secure key fob** (USB-C YubiKey-style; we ship physical hardware that holds the agent's private key)
- **NFC payment cards** (we already have virtual cards via `cards.js`; ship physical NFC-enabled)
- **Voice agent number** (`voice_agents.js`; provision a real US/EU phone number)
- **Physical mailbox forwarding** (logistics primitive; agents get a real street address)

---

## What it costs to plug all the gaps

| Window | Spend | Headcount | Hiring focus |
|---|---|---|---|
| Days 0-30 | $35K (legal, tooling, insurance) | 1 | — |
| Days 30-90 | $200K | 3 | GTM, eng #2, designer |
| Months 3-6 | $1.5M | 7 | SRE, security, CSM, AE, SDR |
| Months 6-12 | $5M (Series Seed) | 15 | EU/APAC hire, second AE pod, CFO frac |
| Months 12-24 | $15M | 35 | Vertical agent product teams |
| Months 24-36 | $60M (Series A) | 80 | Geographic expansion, hyperscaler partnerships |
| Months 36-60 | $250M (Series B + C) | 200 | International, regulated industries |
| Months 60-84 | IPO at $20-40B | 500 | Public-company readiness |

Total dilution through IPO: ~50%. Founder retains ~20-25% of equity.

---

## The five things that, if you do nothing else this week, you must do

1. **Form the C-Corp + register the domain + open the bank account.** Without this, no money flows. ($500, 3 days.)
2. **Submit MCP manifest to Smithery, mcp.run, ClaudePluginHub.** Free distribution to every Claude/Cursor/VS-Code user. (1 hour.)
3. **Post Show HN on a Tuesday at 9am ET.** Single highest-leverage distribution event possible. (4 hours of prep.)
4. **Email 25 known agent-infra investors with the deck.** First pre-seed term sheet inbound = clock starts. (1 day.)
5. **Ship 10 reference agents to GitHub and tweet them.** Each one is a viral demo. (We already have them in `reference-agents/`; just polish + tweet.)

---

## The single sentence that summarises the gap

We have built the most complete agent substrate in the world. We
have not yet built a *company*. Tier 0 turns this repository into a
company. Tiers 1-4 turn the company into a $10B+ outcome. The repo
is the easy half. Ship.
