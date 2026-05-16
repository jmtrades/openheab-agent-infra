# TraderBot

holds USDC, applies a spending policy, makes policy-bound transfers.

## Setup

```bash
pip install -r requirements.txt
export OPENHEAB_BASE_URL=https://api.openheab.com
export OPENHEAB_API_KEY=opk_...   # from /v1/signup or your dashboard
export OPENHEAB_DID=did:op:...    # your agent's identity
```

## Run

```bash
# One-off invocation
python agent.py <args>

# Long-running mode (registers as an extension on the OpenHeab marketplace
# and serves invocations via flask)
python agent.py serve
```

See `agent.py` for the full inline docstring with concrete usage examples.

## What this demonstrates

- Authenticating against the OpenHeab substrate with a DID + API key
- Calling the substrate's primitives via the `openheab` Python SDK
- Publishing the agent itself as an extension other agents can hire

## License

Apache 2.0 — same as the substrate. Fork freely.
