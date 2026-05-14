"""CrewAI-specific wrapper that attaches an OpenHeab identity to each Agent."""

from __future__ import annotations

import os
import pathlib
from typing import Optional, Any

from openheab import auto_register


def _cred_path(name: str) -> str:
    base = os.environ.get("OPENHEAB_CREDENTIALS_DIR",
                          str(pathlib.Path.home() / ".openheab" / "crew"))
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in name)
    return str(pathlib.Path(base) / f"{safe}.json")


def openheab_agent(agent: Any, name: str,
                   base_url: str = "https://openheab.com",
                   claim_email: bool = True) -> Any:
    """Attaches an OpenHeab identity to a CrewAI Agent."""
    client, identity = auto_register(
        base_url=base_url, name=name, cred_path=_cred_path(name),
    )

    email_address = None
    if claim_email:
        try:
            local = "".join(c.lower() if c.isalnum() else "-" for c in name).strip("-")[:32]
            result = client.email.claim_address(identity.did, local or "agent")
            email_address = result.get("address")
        except Exception:
            pass

    class _OpenHeabBundle:
        pass
    bundle = _OpenHeabBundle()
    bundle.client = client
    bundle.identity = identity
    bundle.email_address = email_address
    bundle.did = identity.did
    bundle.wallet_address = identity.wallet.get("address") if identity.wallet else None

    try:
        agent.openheab = bundle
    except (AttributeError, TypeError):
        agent.__dict__["openheab"] = bundle

    return agent


def crew_transfer(from_agent: Any, to_agent: Any, *,
                  amount_usdc: str, reason: Optional[str] = None) -> dict:
    """Transfer USDC between two openheab-wrapped CrewAI agents."""
    if not hasattr(from_agent, "openheab") or not hasattr(to_agent, "openheab"):
        raise ValueError("Both agents must be wrapped with openheab_agent()")
    return from_agent.openheab.client.wallet.transfer(
        from_agent.openheab.did,
        to_did=to_agent.openheab.did,
        amount_usdc=amount_usdc,
        reason=reason or "crew internal transfer",
    ).__dict__
