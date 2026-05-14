# Launch posts — copy & paste

## 1. Hacker News — Show HN

**Title:** Show HN: OpenHeab – an agent-native substrate (DID + USDC wallet + KYC + MCP)

**Body:**
```
Hey HN — I'm 17, building OpenHeab solo from London.

It's a substrate for AI agents. Every agent gets:
- A signed DID identity (Ed25519, did:op:…)
- A non-custodial USDC wallet on Base (FeeSplitter contract taking 1%)
- KYC against OFAC + UN + UK HMT + EU CFSP + OpenSanctions PEP
- An @openheab.com email address
- Signed A2A messaging, structured memory (KV + episodic + pgvector)
- Reputation, marketplace, extensions with 70/30 split
- Multi-provider LLM router with cost tracking
- Prompt injection + PII + secrets scanning
- Workflow engine, encrypted secrets vault, file storage
- OAuth bridge for Slack/GitHub/Google/Notion/Linear

Every state change signs into a Merkle-style audit chain.

The interesting part: it's also an MCP server. 34 tools at /mcp so any
Claude/OpenAI/Cursor agent can use the substrate natively without an adapter.

42 primitives, 334 routes. Apache 2.0. Express + Neon Postgres on Vercel.

Live: https://openheab.com
MCP: https://openheab.com/.well-known/mcp.json
Code: https://github.com/jmtrades/openheab-agent-infra

Feedback brutal welcome.
```

## 2. Twitter / X thread

```
1/ Shipping OpenHeab today.

It's a substrate. Every AI agent gets:
- DID identity (Ed25519)
- USDC wallet on Base (1% take rate)
- KYC against 5 sanctions sources
- @openheab.com email
- Signed A2A messaging + memory
- Audit chain anyone can verify

42 primitives. 334 routes. Apache 2.0.

https://openheab.com

2/ It's also an MCP server. 34 tools at /mcp.

Any Claude / OpenAI / Cursor agent can use the substrate natively.

   https://openheab.com/mcp

3/ The thesis: as AI agents become dominant internet traffic, someone owns
the rails — identity, payments, trust. I'm building that someone to be
open, neutral, and audit-chain backed.

4/ GitHub: github.com/jmtrades/openheab-agent-infra
```

## 3. Anthropic Discord — #show-and-tell

```
Just shipped OpenHeab as an MCP server. 42-primitive substrate exposed
as 34 MCP tools at /mcp.

Add to Claude Desktop config:
{
  "mcpServers": {
    "openheab": {
      "url": "https://openheab.com/mcp",
      "auth": "Bearer YOUR_OPK_API_KEY"
    }
  }
}

Get an API key: curl -X POST https://openheab.com/v1/identities
Apache 2.0: github.com/jmtrades/openheab-agent-infra
```

## 4. Product Hunt launch comment

```
Hey everyone — built OpenHeab solo. Agent-native infrastructure substrate.

Try it in 30 seconds:

1. curl -X POST https://openheab.com/v1/identities -d '{}'
2. You get a DID, USDC wallet on Base, and API key back.
3. Add MCP server to Claude Desktop with one config line.

Apache 2.0. 42 primitives. In production today.
```
