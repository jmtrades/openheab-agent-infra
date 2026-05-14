# agents.json — agent-discoverable platform descriptor (v1)

**Version:** 1.0.0
**Status:** Draft, open for comment
**Maintainer:** OpenHeab + co-publishers
**Location:** Served at `/.well-known/agents.json`

## Motivation

AI agents that browse the web need a fast, machine-readable way to learn what a given platform offers and how to use it. `agents.json` is a small JSON document positioned alongside `robots.txt` and `llms.txt` that answers four questions in 30 lines:

1. What is this platform?
2. What capabilities does it offer?
3. How do I authenticate?
4. How do I get started?

## Schema

```jsonc
{
  "name": "OpenHeab",
  "description": "Agent-native substrate: identity, bank, KYC, email, memory.",
  "discovery_protocol_version": "1.0.0",
  "homepage": "https://openheab.com",
  "openapi": "https://openheab.com/openapi.json",
  "license": "Apache-2.0",
  "auth": {
    "methods": ["ed25519_signature", "bearer_api_key"],
    "signature_canonical_form": "METHOD\nPATH\nSHA256(body)",
    "api_key_creation_endpoint": "https://openheab.com/v1/identities"
  },
  "capabilities": [
    { "name": "identity", "description": "Create + manage Ed25519 DIDs" },
    { "name": "bank", "description": "Non-custodial USDC on Base. 1% per transfer." }
  ],
  "pricing": {
    "hosted": "free-tier + 1% bank take rate",
    "self_host": "free under Apache-2.0"
  }
}
```

## Required fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Platform name |
| `description` | string | One-line description (max 280 chars) |
| `discovery_protocol_version` | string | Must be `"1.0.0"` |
| `auth.methods` | string[] | At least one |
| `capabilities` | object[] | At least one |

## Auth methods

| Identifier | Description |
|---|---|
| `bearer_api_key` | Standard `Authorization: Bearer <token>` |
| `ed25519_signature` | Per-request Ed25519 signature |
| `oauth2` | OAuth 2.0 authorization code flow |
| `mtls` | Mutual TLS |
| `none` | No auth required |

## Discovery

Agents looking for `agents.json`:

1. Append `/.well-known/agents.json` to the platform's root URL
2. Fetch with `Accept: application/json`
3. If 404, fall back to scraping the homepage or `openapi.json`

## License

Specification published under CC-BY 4.0. Implementations are unrestricted.
