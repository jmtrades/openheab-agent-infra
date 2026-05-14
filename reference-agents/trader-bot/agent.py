"""
TraderBot — holds USDC, applies a spending policy, makes policy-bound transfers.

Run:
    pip install openheab
    python agent.py setup
    python agent.py transfer DID_OR_ADDRESS AMOUNT REASON
    python agent.py status
"""

import sys
from openheab import auto_register, OpenHeabError

client, agent = auto_register(name="trader-bot")
DID = agent.did
print(f"TraderBot DID: {DID}")


def cmd_setup():
    print("Setting KYC claims...")
    try:
        client.kyc.submit_claim(DID, claim_type="jurisdiction", claim_value="GB")
        client.kyc.submit_claim(DID, claim_type="operator_type", claim_value="autonomous")
        client.kyc.submit_claim(DID, claim_type="agent_class", claim_value="commerce")
        print(f"Tier: {client.kyc.tier(DID)}")
    except OpenHeabError as e:
        print(f"KYC: {e}")
    print("Setting spending policy ($50/tx, $500/day)...")
    try:
        client._request("PUT", f"/v1/agents/{DID}/wallet/policy", {
            "per_tx_limit_raw": "50000000", "daily_limit_raw": "500000000", "paused": False,
        })
    except OpenHeabError as e:
        print(f"Policy: {e}")
    print("Setup complete.")


def cmd_transfer(target, amount, reason):
    is_did = target.startswith("did:op:")
    try:
        tx = client.wallet.transfer(DID,
            to_did=target if is_did else None,
            to_address=None if is_did else target,
            amount_usdc=amount, reason=reason)
        print(f"Sent: tx_hash={tx.tx_hash} status={tx.status}")
    except OpenHeabError as e:
        print(f"Transfer rejected: {e.body}")


def cmd_status():
    print(f"\n=== TraderBot status ===")
    try:
        b = client.wallet.balance(DID)
        print(f"Balance: {b.balance} {b.asset} at {b.address}")
    except OpenHeabError as e:
        print(f"Balance: {e}")


cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
if cmd == "setup":     cmd_setup()
elif cmd == "transfer" and len(sys.argv) >= 5:
    cmd_transfer(sys.argv[2], sys.argv[3], sys.argv[4])
elif cmd == "status":  cmd_status()
else:
    print("Usage: python agent.py [setup|status|transfer DID_OR_ADDR AMOUNT REASON]")
