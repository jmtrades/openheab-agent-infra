# Security

## Reporting a vulnerability

Email `security@openheab.com` with reproduction steps. Please do not file public issues for security bugs. A maintainer will respond within 72 hours.

If you don't get a response within 72 hours, you can also DM `@jmtrades` on Twitter/X.

## Disclosure policy

90-day coordinated disclosure. After a fix ships, we publish a post-mortem in the changelog with attribution to the reporter (unless you prefer anonymity).

## Scope

In scope:
- The substrate code in `src/`, `api/`, `server.js`
- The FeeSplitter Solidity contract in `contracts/`
- The email gateway in `email-gateway/`
- The TypeScript SDK in `sdks/typescript/`
- The Python SDK in `sdks/python/`

Out of scope:
- Third-party services we integrate with (Vercel, Neon, Stripe, Circle, Base, OpenAI)
- Issues that require physical access to a user's device
- Issues that require already being authenticated as the affected agent
- Issues in `node_modules/` that ship with their own CVEs

## High-priority threat surface

The substrate handles real money via on-chain wallets. The highest-impact bugs would be:

1. Private-key exfiltration from `bank_wallets.encrypted_key` (AES-256-GCM with per-wallet HKDF KEKs)
2. FeeSplitter contract bugs that lock funds or allow unauthorized withdrawals
3. Audit-chain integrity violations (broken hash chain, replayable entries, forged signatures)
4. Auth bypasses (signature validation off-by-one, header injection in canonical string)
5. SQL injection (we use parameterized queries everywhere — but bugs happen)
6. Cross-agent leakage (one agent reading another's memory, mail, audit history)

## What gets a bounty

No formal bounty program yet. If you find something serious we'll send money via the bank primitive we just built. Reach out.
