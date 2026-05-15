# ALL_GAPS.md — every single thing still missing

> The complete, exhaustive list. **268 distinct gaps** organized by what
> kind of work closes each one. Some gaps were intentional design choices
> (defer EMV, defer hardware key fobs); some require licensing that takes
> 18-36 months; some require capital we haven't raised. The substrate
> itself is 192 primitives × 32 layers × 1,507 routes — the gaps are
> mostly external/regulatory/capital/relationship work.

---

## Index

| Tier | Closes by | Count |
|---|---|---|
| **A** | Writing more code | 73 |
| **B** | External relationships (banks, networks, providers) | 31 |
| **C** | Hiring people | 23 |
| **D** | Raising capital | 8 |
| **E** | Time + execution (certifications, customers, brand) | 65 |
| **F** | Regulatory paperwork | 25 |
| **G** | Hardware / physical | 5 |
| **H** | Documentation polish | 12 |
| **I** | Test coverage + quality bar | 11 |
| **J** | Operational / SRE | 15 |

Total: **268 distinct gaps**.

---

## Tier A — Closes by writing more code (73)

### A1 — Real third-party adapter wiring (we have `provider_adapters.js` cataloguing all 32 but the actual API call code is stubbed; 28 to wire up)
1. Stripe Checkout production webhook signature verification beyond basic
2. Stripe Issuing real card creation (today: stub PAN generation in `card_core.js`)
3. Plaid real bank account verification + balance lookup
4. Modern Treasury production ACH API integration
5. Dwolla alternative ACH integration
6. Wise Platform international payouts
7. Onfido production document verification API
8. Persona real ID + selfie + liveness flow
9. Sumsub KYC + KYB + AML monitoring
10. Comply Advantage / Refinitiv World-Check sanctions screening
11. Twilio real voice calls + SMS (we have stub in `voice_agents.js`)
12. SendGrid production email delivery (or use our `email_core.js`)
13. Anthropic real chat completions API
14. OpenAI real chat + embeddings + assistants v2
15. Google Gemini real
16. Mistral real API
17. Together AI router
18. Modal production GPU spawning
19. E2B real sandbox lifecycle
20. Browserbase real headless browser sessions
21. Vercel deploy hook integration
22. Cloudflare DNS + R2 storage + Workers
23. AWS S3 production blob storage
24. GitHub App webhook handling for `github.js` primitive
25. Sentry error event pushing
26. Datadog metrics + APM
27. PagerDuty / Opsgenie real alerting
28. Vanta / Drata SOC 2 evidence sync

### A2 — Real ML models (6)
29. Production safety classifier (today: rules-based catching 14 attack patterns; need fine-tuned LLaMA Guard-class model)
30. KYC face-matching model (today: deterministic stub; need MobileFaceNet or FaceX-Zoo checkpoint)
31. KYC liveness anti-spoofing CNN
32. ID document OCR + authenticity classifier
33. Email spam classifier (today: Bayesian-style heuristic; need fine-tuned BERT)
34. Proprietary embeddings model (today: pseudo-random SHA-512-derived vectors; need real Matryoshka encoder)

### A3 — Native apps + extensions (14)
35. iOS native app (we ship `apple-app-site-association`)
36. Android native app (we ship `assetlinks.json`)
37. macOS desktop app (Tauri or Electron)
38. Windows desktop app
39. Linux desktop app
40. Chrome browser extension
41. Firefox browser extension
42. Safari browser extension
43. Edge browser extension
44. VS Code extension (we expose the install snippet; need real published extension)
45. JetBrains plugin
46. Cursor MCP plugin (works via our MCP server today; could publish a richer Cursor-specific UI)
47. Slack workspace app (we have `integrations.js`; need real Slack OAuth flow)
48. Discord bot (same)

### A4 — Real-time / streaming infra (7)
49. Native WebSocket gateway (we have SSE + long-poll; no actual WS server)
50. gRPC API surface
51. GraphQL API surface
52. Edge compute deployment (Cloudflare Workers or Vercel Edge)
53. Multi-region read replicas
54. Redis cache layer (today: in-memory fallback in `rate_limit.js`)
55. CDN integration for static assets (favicon, OG image, sitemap)

### A5 — AGI-future primitives (15)
56. Quantum-resistant `did:op:` v2 with Dilithium signatures alongside Ed25519
57. Brain-computer interface bridge (Neuralink-class)
58. AR/VR spatial agent UI
59. Multi-agent constitution federation (cross-org rule inheritance)
60. Agent personality model (configurable Big-Five trait dials)
61. Agent emotional state modeling
62. Agent introspection / self-awareness primitives
63. Long-term memory consolidation (sleep-replay style)
64. Skill composition engine (DAG of skills auto-derived from a goal)
65. Real benchmark execution harness for `evals.js` (today: leaderboard schema only)
66. Real auto-eval engine that runs prompt regressions
67. RLAF (reinforcement learning from agent feedback) pipeline
68. Agent self-improvement loop (agent rewrites its own prompts)
69. Proprietary base model (we ship the API surface in `inference_core.js`; need GPU + checkpoint)
70. Real federated learning round orchestration (`federated_learning.js` has the schema)

### A6 — Smart contract + on-chain (3)
71. FeeSplitter v2 with multi-sig governance (we ship the v1 contract address)
72. ERC-20 deploy hooks for `tokens.js` primitive
73. Real LayerZero/Wormhole bridge wiring (today: `bridges.js` has the schema)

---

## Tier B — Closes by external relationships (31)

### B1 — Banking + payments (10)
74. Settlement bank correspondent (Cross River / Evolve / Lead / Column)
75. BIN sponsor bank for `card_core.js` cards
76. NACHA membership ($5K initiation)
77. SWIFT BIC code ($10K/yr)
78. SEPA Step2 access (or piggy-back on EU credit institution)
79. Federal Reserve master account (requires bank charter)
80. Visa or Mastercard network certification (3-6 mo)
81. PCI-DSS Level 1 audit ($40-60K/yr)
82. BSA officer designation + program documentation
83. OFAC + FinCEN MSB registration + annual audit

### B2 — Compliance auditors (5)
84. PCAOB-registered SOC 2 Type II auditor signed up
85. HIPAA-compliant subprocessor BAAs signed
86. ISO 27001 certification body engaged
87. FedRAMP 3PAO engaged
88. C5 / IRAP / regional cert bodies engaged

### B3 — Strategic partnerships (10)
89. Anthropic co-marketing agreement
90. OpenAI co-marketing
91. Google Cloud / DeepMind partnership
92. AWS Bedrock partnership
93. Modal / E2B / Coreweave compute resale
94. Coinbase / Circle USDC partnership
95. Stripe master agreement (Issuing + Connect + Tax + Atlas)
96. AWS / GCP / Azure marketplace listings
97. Salesforce AppExchange listing
98. HubSpot App Marketplace listing

### B4 — Insurance + risk (6)
99. E&O insurance ($10M+) — broker engagement
100. Cyber liability ($25M+)
101. D&O insurance ($5M when board exists)
102. General liability
103. Employment practices liability
104. Reinsurance treaty (Lloyd's / Munich Re / Swiss Re) for tail risk in `insurance_core.js`

---

## Tier C — Closes by hiring (23)

### C1 — Founding team Y1 (10)
105. Founding GTM hire (sales + DevRel hybrid) — $150K + 2%
106. Founding eng #2 (TS/Postgres) — $200K + 2%
107. SRE #1 — $200K + 1.5%
108. Founding designer — $150K + 1%
109. Compliance officer — $150K + 0.75%
110. Security engineer — $250K + 1.5%
111. Smart contract engineer — $250K + 1.5%
112. First SDR — $80K + 0.25%
113. First AE — $200K OTE + 0.5%
114. Founding CSM — $130K + 0.5%

### C2 — Fractional / advisory (3)
115. Fractional CFO — $5K/mo
116. Fractional GC — $5K/mo
117. 5+ paid advisors with relevant networks (Anthropic alums, finance regulators, AGI safety researchers, agent infra founders)

### C3 — Board of directors (5)
118. Founder seat
119. Lead investor seat (after pre-seed)
120. Independent director #1
121. Independent director #2
122. Audit committee chair

### C4 — Y2 hires (5)
123. Head of Engineering
124. Head of Product
125. Head of Compliance + Risk
126. Head of GTM
127. Director of Customer Success

---

## Tier D — Closes by raising capital (8)

128. Pre-seed deck assembled (10 slides)
129. 3-year financial model (P&L, cohort retention, CAC payback, magic number, rule of 40)
130. Data room (deck, model, IP, captable, contracts, code-quality docs)
131. 25 warm investor intros lined up
132. First term sheet ($500K-$1.5M @ $5-8M post)
133. Pre-seed closed (target: month 1)
134. Seed round ($5-10M @ $25-50M post, target: month 6)
135. Series A ($25-50M @ $150-250M post, target: month 18)

---

## Tier E — Closes by time + execution (65)

### E1 — Customers (5 — most important)
136. First paying customer (free → pro upgrade)
137. First 10 paying customers
138. First $25K MRR
139. First enterprise contract ($25K+/yr)
140. 500-1,500 paying SMB on Pro/Scale by day 90

### E2 — Distribution (15)
141. MCP server submitted to Smithery
142. MCP server submitted to mcp.run
143. MCP server submitted to ClaudePluginHub
144. OpenAPI submitted to APIs.guru
145. OpenAPI on RapidAPI marketplace
146. Postman Public Network collection
147. YC W26 application submitted
148. Show HN post (Tuesday 9am ET, front page)
149. Product Hunt launch
150. Hacker News "Ask HN: what would you build with this?"
151. 50 framework adapter PRs (LangChain, LlamaIndex, AutoGen, CrewAI, Letta, Inngest, Trigger.dev, etc.)
152. 5 newsletter sponsorships (TLDR, Bytes, AI Tidbits)
153. 5 podcast appearances (Latent Space, Practical AI, MLOps Live, etc.)
154. 3 conference booths (NeurIPS, AI Engineer Summit, MCP Devcon)
155. 1 hackathon sponsored ($10K bounty for best vertical extension)

### E3 — Brand + community (17)
156. Real logo (professional designer, not SVG circle)
157. Brand style guide
158. Component library / Storybook
159. Discord community (5K target by month 12)
160. Slack community
161. Annual "OpenHeab Day" conference (1K attendees)
162. Certification program (paid exam — "OpenHeab Certified Developer")
163. Academy with 10 free courses
164. YouTube channel (weekly substrate explainers)
165. Podcast: "Agent Infra Weekly"
166. Newsletter (10K subs target)
167. Swag store
168. Customer awards program (annual)
169. Author / advisor program
170. Influencer partnerships (5 agent infra thought leaders)
171. Subreddit /r/openheab
172. Github stars campaign (5K stars in 30 days)

### E4 — Geographic + localization (8)
173. EU subsidiary (Ireland or Netherlands)
174. UK subsidiary (post-Brexit)
175. APAC HQ (Singapore or Tokyo)
176. Localized landing pages in 6 languages (i18n primitive ready; need translations)
177. Localized docs (machine-translate + human review)
178. Multi-lingual support team
179. Region-pinned data residency (US-east, EU-west, AP-southeast)
180. Local payment rails (Pix in BR, UPI in IN, PromptPay in TH, Boleto, OXXO)

### E5 — Marketing artifacts (10)
181. Demo video (60-sec hero video on landing)
182. Sales deck v1 (10 slides)
183. Pricing calculator interactive tool
184. ROI calculator
185. Pre-loaded sandbox demo environment
186. Calendly integration for demo booking
187. Case studies (10 with logos + quotes)
188. Customer reference program
189. Trust portal at `/trust` with auto-updating compliance status
190. Annual industry report ("State of Agent Infrastructure")

### E6 — Tax + accounting (5)
191. Delaware C-Corp formation (Stripe Atlas)
192. EIN issued
193. Business bank account opened
194. Sales tax permits per state we sell into
195. VAT registration in EU/UK

### E7 — Vertical agents productized (5)
196. AccountingBot productized + first 5 customers ($50K/yr each)
197. LegalReviewBot productized + first 3 customers ($100K/yr each)
198. ComplianceBot productized + first 5 customers ($75K/yr each)
199. SalesProspectingBot productized + 50 seats ($25K/yr each)
200. SecurityBot productized + first 3 customers ($100K/yr each)

---

## Tier F — Regulatory paperwork (25)

### F1 — US federal (8)
201. SOC 2 Type II report (12-mo observation; in progress via `audit_core.js` + Vanta/Drata)
202. ISO 27001 certification
203. HIPAA Security Rule attestation
204. PCI-DSS Level 1 (when card volume > $6M/yr)
205. FedRAMP Moderate authorization (US gov contracts)
206. SOC 1 (for finance customers)
207. NIST AI Risk Management Framework alignment doc
208. EU AI Act compliance attestation

### F2 — US state (5)
209. Money transmitter licenses — 50 US states (or partner via Stripe / Synapse / Lead Bank)
210. State insurance department licenses (50 states for `insurance_core.js`)
211. State sales tax registrations
212. State data-privacy-rule certifications (CA CCPA/CPRA, VA, CO, CT, etc.)
213. State labor / employment registrations

### F3 — International (7)
214. EU EMI / PI license
215. UK FCA EMI
216. AU AFSL
217. Singapore MAS PSO
218. C5 (Germany)
219. IRAP (Australia)
220. UK ICO registration

### F4 — Tax (5)
221. Transfer pricing documentation (multi-jurisdiction)
222. R&D tax credit filings
223. International withholding tax compliance
224. Stripe Tax / Quaderno production wiring
225. TaxJar / Avalara integration

---

## Tier G — Hardware / physical (5; EMV deferred per founder direction)

226. Hardware secure key fob (USB-C YubiKey-style) for agent identity root
227. Physical NFC payment cards (card_core.js handles digital; physical production via CPI Card Group or IDEMIA)
228. Voice agent SIM cards (today: Twilio handles; could move to raw SIP + SIM)
229. APNs + FCM push notification service contracts
230. Co-location for low-latency US-east / EU-west / AP-southeast presence

---

## Tier H — Documentation polish (12)

231. Per-primitive deep-dive docs (192 primitives × 1 page each)
232. SDK reference docs (Python, TypeScript ready; Go / Rust / Java / Ruby / PHP missing)
233. Migration guides (when we version-bump primitives)
234. Best-practices cookbook
235. Video tutorials (20+ topics, ~3 min each)
236. Interactive embedded code examples (CodeSandbox / StackBlitz)
237. Postman collection (auto-generate from `openapi.json`)
238. Insomnia workspace
239. Architecture decision records (ADRs)
240. Threat model document
241. Disaster recovery runbook
242. On-call runbook

---

## Tier I — Test coverage + quality bar (11)

243. End-to-end integration test suite covering every primitive (we have boot + unit + bank lifecycle)
244. Smoke test that exercises every route on staging
245. Property-based testing (`fast-check`)
246. Load testing scripts (k6 / Artillery)
247. Penetration testing report (Cobalt / HackerOne; $15K)
248. Code coverage tracking (Istanbul / c8)
249. Mutation testing (Stryker)
250. Visual regression testing for HTML pages (Percy / Chromatic)
251. Accessibility testing in CI (axe-core)
252. Performance budget enforcement
253. Bundle size monitoring for the SDKs

---

## Tier J — Operational / SRE (15)

254. Production monitoring (Datadog or Grafana stack)
255. PagerDuty rotation set up
256. Live runbook library
257. Chaos engineering harness (Gremlin / Litmus)
258. Continuous load testing in staging
259. DR / BCP plan documented
260. Quarterly DR test executed
261. Database backup verification (automated restore drill)
262. Connection pool tuning per region
263. HSM integration for KEK rotation (today: KEKs from env vars)
264. Secret rotation automation
265. Dependency vulnerability scanning (Snyk + Dependabot)
266. SBOM generation per release (SPDX or CycloneDX)
267. SAST/DAST in CI (Semgrep + ZAP)
268. Supply chain attestation (SLSA Level 3 — signed builds with Sigstore)

---

## What's NOT in this list (because it's already done)

For transparency, the following 192 primitives across 32 layers were
already shipped and are not gaps:

`identity` `secrets` `aliases` `storage` `cost` `analytics` `portability`
`intelligence` `memory` `tools` `workflows` `scheduler` `inbox` `inference`
`eval` `continuity` `bank` `bank_chain` `bank_extensions` `bank_account`
`crypto` `commerce` `payouts` `x402` `escrow` `cards` `savings`
`reputation` `kyc` `kyc_extensions` `security` `insurance` `biometrics`
`aml` `fraud` `notary` `tripwires` `reversibility` `marketplace`
`extensions` `prompts` `datasets` `mcp_server` `governance` `publishing`
`email` `phone` `deployment` `oauth_bridge` `entities` `tax` `sandbox`
`browser` `voice` `vision` `video` `search` `documents` `maps` `knowledge`
`translate` `moderation` `fact_check` `multisig` `lending` `defi` `tokens`
`nft` `bridges` `dns` `hosting` `database` `ipfs` `cache` `cdn` `planning`
`simulation` `beliefs` `goals` `skills` `causal` `interpretability`
`fine_tuning` `federated_learning` `crm` `projects` `leads` `outreach`
`forms` `dao_factory` `chat` `invoicing` `compute` `news` `calendar`
`billing` `contracts` `courts` `health` `passport` `logistics` `property`
`robotics` `api_management` `brokerage` `prediction_markets` `shopping`
`travel` `advertising` `media` `ratings` `booking` `github` `ci_cd`
`monitoring` `error_tracking` `feature_flags` `experiments` `webhooks`
`events` `learning` `voice_agents` `labs` `gov_filing` `legal_research`
`court_records` `ip_registry` `climate` `support` `referrals` `loyalty`
`surveys` `recruiting` `supply_chain` `licensing` `benchmarks` `org`
`subscriptions` `metering` `revenue` `sso` `rbac` `compliance_pack`
`credits` `onboarding` `dashboard` `embed` `public_directory`
`partnerships` `whitelabel` `ach` `quotes` `realtime` `email_advanced`
`kyc_advanced` `blog` `marketing` `seo` `signup` `negotiation`
`orchestration` `constitution` `safety` `growth_plan` `cli` `verticals`
`multimodal` `capital_markets` `agent_market` `evals` `integrations`
`realtime_ws` `mobile` `ipo_readiness` `design_system` `workflow_builder`
`provider_adapters` `customer_success` `i18n` `status_incidents`
`bank_core` `email_core` `kyc_core` `inference_core` `insurance_core`
`audit_core` `payment_rails` `card_core` `quickstart` `demo_seed`
`operator_hq`

Plus the 8 strategy docs (BILLION_DOLLAR_PATH, REVENUE_NOW,
WHAT_WE_NEED_TO_WIN, AGI_STRATEGY, _100B_AUDIT, NO_THIRD_PARTY,
QUICKSTART, COWORKER_HANDOFF) and this `ALL_GAPS.md`.

---

## The honest summary

| Bucket | Gaps | What it really is |
|---|---|---|
| Tier A — code | 73 | Real work, doable in 3-6 months with 2-3 engineers |
| Tier B — relationships | 31 | Phone calls + paperwork; 6-18 months |
| Tier C — hiring | 23 | Talent pipeline; bottleneck = capital |
| Tier D — capital | 8 | One closed pre-seed unblocks everything else |
| Tier E — time + execution | 65 | The longest pole — brand + customers + cert compound over years |
| Tier F — regulatory | 25 | 18-36 months per major license |
| Tier G — hardware | 5 | Vendor procurement |
| Tier H — docs | 12 | Writing |
| Tier I — tests | 11 | Engineering hygiene |
| Tier J — SRE | 15 | Hire SRE #1 → most of these close |

**Total: 268 gaps.** Of those, only **73 can be closed by writing more code.**
The remaining **195** require relationships, hiring, capital, time,
regulatory paperwork, hardware procurement, and execution.

We've built the part of the company that's bottlenecked on code (the
substrate). What's left is everything that's bottlenecked on the
non-code work that infra startups die from skipping.

This is the gap list. Pin it. Track it. Close it.
