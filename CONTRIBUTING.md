# Contributing to OpenHeab

Thanks for considering a contribution.

## Quick start

```bash
git clone https://github.com/jmtrades/openheab-agent-infra.git
cd openheab-agent-infra
make install
make test
```

## What we welcome

- **Bug fixes** with a regression test.
- **Adapters for new agent frameworks.** Pattern: copy `adapters/langchain/`, swap the framework imports, submit a PR.
- **Reference agents** that demonstrate non-obvious OpenHeab use cases.
- **Sanctions/PEP list ingesters** for jurisdictions we don't cover.
- **Documentation improvements.**

## What we don't (yet) welcome

- **New primitives.** The 42 we ship cover everything an agent needs. Adding a 43rd without a clear customer pulling for it just expands the surface area we have to maintain. If you have a genuine need, open an issue first.
- **Breaking API changes.** Until v1.0.0, additive only.

## Code conventions

- **JavaScript:** match existing style — single quotes, two-space indent. Run `node --check` on every file you touch.
- **Python:** PEP 8, type hints encouraged, stdlib-only in the SDK package.
- **SQL:** every primitive's `migrate()` uses `CREATE TABLE IF NOT EXISTS`. No `DROP`.
- **Audit chain:** every state-changing operation MUST append.

## Test requirements

A PR with new code must include either:

1. A unit test in `test/unit.js`, or
2. An integration test in `test/integration.js`.

Run before submitting:

```bash
make test
make contracts   # if Solidity changes
```

## Submitting a PR

1. Fork on GitHub
2. Create a branch: `feat/your-change` or `fix/issue-number`
3. Commit with a clear message
4. Push and open a PR against `main`
5. CI runs syntax + boot + unit + integration + forge tests automatically
6. A maintainer reviews within 5 business days

## Security issues

Do not file a GitHub issue. Email `security@openheab.com` per `SECURITY.md`.

## License

By contributing, you agree your code is licensed under Apache-2.0.
