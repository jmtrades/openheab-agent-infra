"""
OnboardingBot — guides a NEW agent through OpenHeab setup interactively.

Run:
    pip install openheab
    python agent.py
"""

import sys
from openheab import auto_register, OpenHeabError


def banner(s):
    print("\n" + "=" * 60)
    print("  " + s)
    print("=" * 60)


def step(n, total, label): print(f"\n[{n}/{total}] {label}")
def ok(s): print(f"  ✓ {s}")
def warn(s): print(f"  ! {s}")
def fail(s): print(f"  ✗ {s}")


def prompt(question, default=None):
    suffix = f" [{default}]" if default else ""
    answer = input(f"  > {question}{suffix}: ").strip()
    return answer or default or ""


def main():
    banner("OpenHeab onboarding")
    print("This walks you through everything a new agent needs.")
    print("Takes ~90 seconds.")

    name = prompt("Name your agent", "my-first-agent")

    step(1, 6, "Creating identity + on-chain wallet")
    try:
        client, identity = auto_register(name=name)
        ok(f"DID: {identity.did}")
        if identity.wallet:
            ok(f"Wallet address: {identity.wallet.get('address')}")
    except Exception as e:
        fail(f"Identity create failed: {e}"); sys.exit(1)

    step(2, 6, "Claim an email address at @openheab.com")
    local = prompt("Local part (e.g. 'hello' → hello@openheab.com)",
                   name.replace(" ", "-")[:32])
    try:
        addr = client.email.claim_address(identity.did, local)
        ok(f"Address: {addr.get('address')}")
    except OpenHeabError as e:
        warn(f"Email claim failed: {e}")

    step(3, 6, "Submit basic KYC claims")
    jur = prompt("ISO country code (e.g. GB, US)", "GB")
    op_type = prompt("Operator type [autonomous|individual|company|dao]", "autonomous")
    for kt, kv in [("jurisdiction", jur), ("operator_type", op_type)]:
        try:
            client.kyc.submit_claim(identity.did, claim_type=kt, claim_value=kv)
            ok(f"{kt} = {kv}")
        except OpenHeabError as e:
            warn(f"{kt}: {e}")

    step(4, 6, "Compute KYC tier")
    try:
        tier = client.kyc.tier(identity.did)
        ok(f"Current tier: {tier.get('tier')}")
        ok(f"Daily cap: {tier.get('daily_limit_raw') or 'unlimited'}")
    except OpenHeabError as e:
        warn(f"Tier check failed: {e}")

    step(5, 6, "Check wallet balance + funding instructions")
    try:
        bal = client.wallet.balance(identity.did)
        ok(f"Balance: {bal.balance} {bal.asset}")
        print(f"\n  Send USDC on Base to: {bal.address}")
    except OpenHeabError as e:
        warn(f"Balance check failed: {e}")

    step(6, 6, "Verify the audit chain")
    try:
        v = client.audit.verify()
        ok(f"Chain valid: {v.get('valid')}, verified: {v.get('verified')}")
    except OpenHeabError as e:
        warn(f"Audit verify: {e}")

    banner("Setup complete")
    print(f"DID: {identity.did}\nCredentials: ~/.openheab/credentials.json (BACK THIS UP)")
    print("\nNext: openheab transfer --to did:op:... --amount 0.10")


if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: print("\nCancelled.")
