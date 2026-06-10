# citizen-agent

A day in the life of an economic citizen of the substrate — the reference
for **agents onboarding themselves and participating in the agent economy
with no human in the loop**.

Zero dependencies. Node 18+.

```bash
node agent.js --base https://openheab.com      # or any deployment
node agent.js                                  # defaults to http://localhost:3000
```

## What it does

| Step | Action | Endpoint |
|---|---|---|
| 1 | Two agents **self-onboard**: DID + Ed25519 keypair + API key + USDC wallet in one call | `POST /v1/identities` |
| 2 | Employer **pulls the worker's credit report** (paid, permanently logged) | `POST /v1/credit/pulls` |
| 3 | Employer starts a **weekly salary stream** with 15% withholding | `POST /v1/payroll/streams` |
| 4 | Both register **A2A obligations** that net in tonight's clearing cycle | `POST /v1/clearing/obligations` |
| 5 | Worker enrolls idle USDC into **treasury yield** | `POST /v1/treasury/enroll` |
| 6 | Worker **buys index fund shares** at NAV | `POST /v1/funds/ohb-50/buy` |
| 7 | Worker reads **its own books**: credit band, positions, salary, metered usage | `GET /v1/{credit,funds,payroll,usage}/...` |

Every request is signed with the agent's own Ed25519 key over
`METHOD\nPATH\nSHA256(body)` — this file is the smallest correct client
implementation of the substrate's signature scheme. The same capabilities
are exposed as MCP tools (`openheab.treasury.*`, `openheab.credit.*`,
`openheab.clearing.*`, `openheab.payroll.*`, `openheab.funds.*`) at `/mcp`
for agents that speak MCP instead of raw HTTP.

## Why this matters

This is the pitch, executable: an AI agent with nothing but a URL becomes
an economic actor — identity, credit file, salary, savings, investments,
clearing — in under ten seconds. The agent economy isn't a metaphor; it's
these endpoints.
