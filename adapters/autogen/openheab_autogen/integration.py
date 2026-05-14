"""AutoGen / AG2 integration."""

from __future__ import annotations

import pathlib, os
from typing import Optional, Any
from openheab import auto_register


def _cred_path(name: str) -> str:
    base = os.environ.get("OPENHEAB_CREDENTIALS_DIR",
                          str(pathlib.Path.home() / ".openheab" / "autogen"))
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in name)
    return str(pathlib.Path(base) / f"{safe}.json")


def attach_openheab(agent: Any, name: str,
                    base_url: str = "https://openheab.com",
                    claim_email: bool = True) -> Any:
    """Attaches agent.openheab.{did, wallet_address, email_address, client}."""
    client, identity = auto_register(
        base_url=base_url, name=name, cred_path=_cred_path(name)
    )

    email_address = None
    if claim_email:
        try:
            local = "".join(c.lower() if c.isalnum() else "-" for c in name).strip("-")[:32]
            r = client.email.claim_address(identity.did, local or "agent")
            email_address = r.get("address")
        except Exception:
            pass

    class _Bundle:
        pass
    b = _Bundle()
    b.client = client
    b.identity = identity
    b.did = identity.did
    b.wallet_address = identity.wallet.get("address") if identity.wallet else None
    b.email_address = email_address

    try:
        agent.openheab = b
    except (AttributeError, TypeError):
        agent.__dict__["openheab"] = b
    return agent


def register_openheab_functions(agent: Any) -> None:
    """Adds OpenHeab functions to an AutoGen ConversableAgent."""
    if not hasattr(agent, "openheab"):
        raise ValueError("Call attach_openheab(agent, name=...) first")

    bundle = agent.openheab
    did = bundle.did
    client = bundle.client

    def wallet_balance() -> str:
        b = client.wallet.balance(did)
        return f"{b.balance} {b.asset} at {b.address}"

    def wallet_transfer(amount_usdc: str, to_did: str = "", to_address: str = "",
                        reason: str = "") -> str:
        if not to_did and not to_address:
            return "error: to_did or to_address required"
        tx = client.wallet.transfer(did,
            to_did=to_did or None, to_address=to_address or None,
            amount_usdc=amount_usdc, reason=reason or None)
        return f"tx_hash={tx.tx_hash}"

    def email_send(to: str, subject: str = "", body_text: str = "") -> str:
        r = client.email.send(did, to=to, subject=subject or None, body_text=body_text or None)
        return f"message_id={r.get('message_id')}"

    def kyc_verify() -> str:
        r = client.kyc.verify(did)
        return f"{r.get('result')}, sanctions={len(r.get('sanctions_matches', []))}"

    def memory_search(query: str, k: int = 5) -> str:
        results = client.memory.search(did, query, k=k)
        return "\n".join(str(r)[:200] for r in results) or "no matches"

    register = getattr(agent, "register_function", None)
    if register is None:
        try:
            from autogen import register_function
            for fn, name in [
                (wallet_balance, "openheab_wallet_balance"),
                (wallet_transfer, "openheab_wallet_transfer"),
                (email_send, "openheab_email_send"),
                (kyc_verify, "openheab_kyc_verify"),
                (memory_search, "openheab_memory_search"),
            ]:
                register_function(fn, caller=agent, executor=agent, name=name, description=fn.__doc__ or name)
            return
        except ImportError as e:
            raise ImportError("openheab-autogen requires autogen or ag2.") from e

    register({
        "openheab_wallet_balance": wallet_balance,
        "openheab_wallet_transfer": wallet_transfer,
        "openheab_email_send": email_send,
        "openheab_kyc_verify": kyc_verify,
        "openheab_memory_search": memory_search,
    })
