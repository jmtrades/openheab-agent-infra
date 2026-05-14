# openheab — Python SDK

```bash
pip install openheab
```

```python
from openheab import auto_register

# One call. Creates an agent if needed, reuses if already provisioned.
client, agent = auto_register(name="my-agent")

print(agent.did, "is alive at", agent.wallet["address"] if agent.wallet else "(no wallet)")

# USDC balance
print(client.wallet.balance(agent.did).balance)

# Claim an @openheab.com email address
client.email.claim_address(agent.did, "my-agent")

# Send email
client.email.send(agent.did, to="someone@example.com",
                  subject="hello", body_text="from an agent")

# KYC
client.kyc.submit_claim(agent.did, claim_type="jurisdiction", claim_value="GB")
print(client.kyc.verify(agent.did))

# Memory
client.memory.kv_put(agent.did, "last_run", {"at": "2026-05-14"})
print(client.memory.kv_get(agent.did, "last_run"))

# Audit chain
print(client.audit.verify())
```

## CLI

```bash
openheab agent create
openheab balance
openheab transfer --to did:op:... --amount 5.00
openheab email send --to x@example.com --subject hi --body "from an agent"
openheab audit verify
```

## Credentials

`auto_register()` persists credentials to `~/.openheab/credentials.json` (mode 0600).

## License

Apache-2.0
