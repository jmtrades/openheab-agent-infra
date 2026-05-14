# openheab-agent-infra

**The agent-native infrastructure layer.** Every AI agent that uses it gets a signed DID identity, a non-custodial USDC wallet on Base, KYC against 5 sanctions sources, signed A2A messaging, structured memory, marketplaces, insurance pools, escrow, multi-provider LLM inference, and 34 MCP tools — all behind a Merkle-style audit chain.

```
42 primitives · 334 routes · Apache 2.0
Identity   Bank    Email    KYC     Memory   Reputation
Marketplace  Governance  Audit  Extensions  MCP Server
Inference  Security  Storage  Secrets  Cost  Workflows
Tools  Intelligence  Deployment  Payouts  Prompts  Aliases
Scheduler  OAuth  Insurance  x402  Escrow  Datasets
Entities  Tax  Portability  Continuity  Eval  Analytics
Crypto  Phone  Publishing  Bank-Extensions  KYC-Extensions
```

## Why this exists

By 2030 most internet traffic will be AI agents. Whoever owns the substrate they rely on — identity, payments, trust, marketplace — owns the rails. OpenHeab is building that substrate to be open, neutral, and audit-chain backed so the agent economy doesn't end up enclosed by one or two AI labs.

## Quick start

```bash
git clone https://github.com/jmtrades/openheab-agent-infra.git
cd openheab-agent-infra
npm install
cp .env.example .env
# Fill in DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
# STRIPE_PRICE_PRO_MONTHLY, IDENTITY_MASTER_KEK, CRYPTO_MASTER_KEK,
# OPERATOR_PUBLIC_URL, OPENAI_API_KEY.
npm run migrate
npm start
```

Generate the KEK secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Smoke test

```bash
curl https://<host>/healthz

# Create your first DID
curl -X POST https://<host>/v1/identities \
  -H "content-type: application/json" \
  -d '{"name":"my first agent"}'
# → { did, public_key, private_key, api_key, wallet }   (private materials returned ONCE)

# Use the api_key
export OP_DID=did:op:...
export OP_KEY=opk_...
curl https://<host>/v1/agents/$OP_DID/wallet/balance \
  -H "Authorization: Bearer $OP_KEY"

# Audit chain
curl https://<host>/v1/audit/verify
```

## MCP server

OpenHeab is also an MCP server. 34 tools at `https://<host>/mcp`. Add to Claude Desktop config:

```json
{
  "mcpServers": {
    "openheab": {
      "url": "https://<host>/mcp",
      "auth": "Bearer opk_..."
    }
  }
}
```

## Deploy to Vercel

```bash
npm i -g vercel
vercel login
vercel link
vercel --prod
```

Required env vars: see `.env.example`. The cron jobs in `vercel.json` are auto-registered.

## Architecture

```
   ┌────────────────────────────────────────────────────────────┐
   │   express app (api/index.js | server.js)                   │
   │                                                            │
   │   42 primitive routers, all auth-gated                     │
   │   /v1/_webhooks/stripe   (raw body)                        │
   │   /v1/_jobs/*            (cron-only)                       │
   │   /v1/_admin/migrate     (admin token)                     │
   │   /mcp                   (JSON-RPC 2.0 MCP server)         │
   └─────────────────────────┬──────────────────────────────────┘
                             │
                  ┌──────────▼──────────┐
                  │   Postgres (Neon)   │
                  │                     │
                  │   audit_chain       │ ← every mutation appends
                  │   identities        │
                  │   api_keys          │
                  │   <42 primitive     │
                  │    schemas>         │
                  └─────────────────────┘
```

Every state change appends to a SHA-256-chained audit log. `GET /v1/audit/verify` recomputes and validates the entire chain.

## License

Apache-2.0
