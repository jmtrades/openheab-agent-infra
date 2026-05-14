"""OpenHeabIdentity — drop-in identity provider for LangChain agents."""

from __future__ import annotations

from typing import Optional, List, Any
from openheab import OpenHeab, auto_register
from openheab.client import Identity


class OpenHeabIdentity:
    """A bundle holding the client + identity for one LangChain agent."""

    def __init__(self, client: OpenHeab, identity: Identity):
        self.client = client
        self.identity = identity

    @property
    def did(self) -> str:
        return self.identity.did

    @property
    def wallet_address(self) -> Optional[str]:
        return self.identity.wallet.get("address") if self.identity.wallet else None

    @classmethod
    def auto(cls, base_url: str = "https://openheab.com",
             name: Optional[str] = None, cred_path: Optional[str] = None) -> "OpenHeabIdentity":
        client, identity = auto_register(base_url=base_url, name=name, cred_path=cred_path)
        return cls(client, identity)

    def tools(self) -> List[Any]:
        from .tools import create_openheab_tools
        return create_openheab_tools(self)

    def __repr__(self) -> str:
        return f"<OpenHeabIdentity did={self.did} wallet={self.wallet_address or 'unprovisioned'}>"
