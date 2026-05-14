"""LlamaIndex FunctionTool wrappers for OpenHeab."""

from __future__ import annotations

from typing import Optional, List, Tuple
from openheab import auto_register, OpenHeab
from openheab.client import Identity


class OpenHeabIdentity:
    def __init__(self, client: OpenHeab, identity: Identity):
        self.client = client
        self.identity = identity

    @property
    def did(self) -> str:
        return self.identity.did


def openheab_tools(name: Optional[str] = None,
                   base_url: str = "https://openheab.com",
                   cred_path: Optional[str] = None) -> Tuple[OpenHeabIdentity, List]:
    """Returns (identity, [FunctionTool, ...])."""
    try:
        from llama_index.core.tools import FunctionTool
    except ImportError as e:
        raise ImportError(
            "openheab-llamaindex requires llama-index-core. "
            "Install with: pip install llama-index-core"
        ) from e

    client, identity = auto_register(base_url=base_url, name=name, cred_path=cred_path)
    ident = OpenHeabIdentity(client, identity)
    did = identity.did

    def wallet_balance() -> str:
        """Return the agent's USDC balance on Base."""
        b = client.wallet.balance(did)
        return f"{b.balance} {b.asset} at {b.address}"

    def wallet_transfer(amount_usdc: str, to_did: str = "", to_address: str = "",
                        reason: str = "") -> str:
        """Send USDC to another agent or external address."""
        if not to_did and not to_address:
            return "error: must provide to_did or to_address"
        tx = client.wallet.transfer(did,
            to_did=to_did or None, to_address=to_address or None,
            amount_usdc=amount_usdc, reason=reason or None)
        return f"sent: tx_hash={tx.tx_hash} fee_raw={tx.fee_raw}"

    def email_send(to: str, subject: str = "", body_text: str = "") -> str:
        """Send an email from the agent's @openheab.com address."""
        r = client.email.send(did, to=to, subject=subject or None, body_text=body_text or None)
        return f"sent: message_id={r.get('message_id')}"

    def kyc_verify() -> str:
        """Run KYC verification on the agent."""
        r = client.kyc.verify(did)
        return f"{r.get('result')} ({len(r.get('sanctions_matches', []))} sanctions hits)"

    def memory_search(query: str, k: int = 5) -> str:
        """Semantic search of the agent's memory."""
        results = client.memory.search(did, query, k=k)
        return "\n".join(str(r)[:200] for r in results) or "no matches"

    tools = [
        FunctionTool.from_defaults(fn=wallet_balance, name="openheab_wallet_balance"),
        FunctionTool.from_defaults(fn=wallet_transfer, name="openheab_wallet_transfer"),
        FunctionTool.from_defaults(fn=email_send, name="openheab_email_send"),
        FunctionTool.from_defaults(fn=kyc_verify, name="openheab_kyc_verify"),
        FunctionTool.from_defaults(fn=memory_search, name="openheab_memory_search"),
    ]
    return ident, tools
