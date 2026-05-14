"""LangChain Tool wrappers for the OpenHeab substrate."""

from __future__ import annotations

from typing import Optional, List, Type

try:
    from langchain.tools import BaseTool
    from pydantic import BaseModel, Field
except ImportError as e:
    raise ImportError(
        "openheab-langchain requires langchain. Install with: pip install langchain pydantic"
    ) from e


class WalletBalanceInput(BaseModel):
    """No arguments — checks the agent's own wallet."""


class OpenHeabWalletBalanceTool(BaseTool):
    name: str = "openheab_wallet_balance"
    description: str = "Returns the agent's USDC balance on Base. No arguments."
    args_schema: Type[BaseModel] = WalletBalanceInput

    def __init__(self, identity, **kwargs):
        super().__init__(**kwargs)
        self._identity = identity

    def _run(self) -> str:
        b = self._identity.client.wallet.balance(self._identity.did)
        return f"Address {b.address}: {b.balance} {b.asset}"


class WalletTransferInput(BaseModel):
    to_did: Optional[str] = Field(None, description="Recipient agent DID")
    to_address: Optional[str] = Field(None, description="Recipient ETH address")
    amount_usdc: str = Field(..., description="Amount in USDC, e.g. '5.00'")
    reason: Optional[str] = Field(None, description="Short reason, max 140 chars")


class OpenHeabWalletTransferTool(BaseTool):
    name: str = "openheab_wallet_transfer"
    description: str = "Sends USDC. 1% platform fee. Returns tx_hash."
    args_schema: Type[BaseModel] = WalletTransferInput

    def __init__(self, identity, **kwargs):
        super().__init__(**kwargs)
        self._identity = identity

    def _run(self, amount_usdc: str, to_did: Optional[str] = None,
             to_address: Optional[str] = None, reason: Optional[str] = None) -> str:
        if not to_did and not to_address:
            return "Error: must provide either to_did or to_address"
        tx = self._identity.client.wallet.transfer(
            self._identity.did, to_did=to_did, to_address=to_address,
            amount_usdc=amount_usdc, reason=reason,
        )
        return f"Sent. tx_hash={tx.tx_hash} status={tx.status}"


class EmailSendInput(BaseModel):
    to: str = Field(..., description="Recipient email address")
    subject: Optional[str] = Field(None, description="Email subject")
    body_text: Optional[str] = Field(None, description="Plain text body")


class OpenHeabEmailSendTool(BaseTool):
    name: str = "openheab_email_send"
    description: str = "Sends email FROM the agent's @openheab.com address."
    args_schema: Type[BaseModel] = EmailSendInput

    def __init__(self, identity, **kwargs):
        super().__init__(**kwargs)
        self._identity = identity

    def _run(self, to: str, subject: Optional[str] = None,
             body_text: Optional[str] = None) -> str:
        if not body_text:
            return "Error: must provide body_text"
        r = self._identity.client.email.send(
            self._identity.did, to=to, subject=subject, body_text=body_text,
        )
        return f"Sent. message_id={r.get('message_id')}"


class KycVerifyInput(BaseModel):
    """No arguments."""


class OpenHeabKycVerifyTool(BaseTool):
    name: str = "openheab_kyc_verify"
    description: str = "Returns KYC verification status (clear/flagged/incomplete)."
    args_schema: Type[BaseModel] = KycVerifyInput

    def __init__(self, identity, **kwargs):
        super().__init__(**kwargs)
        self._identity = identity

    def _run(self) -> str:
        r = self._identity.client.kyc.verify(self._identity.did)
        hits = r.get("sanctions_matches") or []
        return f"Result: {r.get('result')}. Sanctions matches: {len(hits)}"


class MemorySearchInput(BaseModel):
    query: str = Field(..., description="Semantic search query")
    k: int = Field(5, description="Number of results")


class OpenHeabMemorySearchTool(BaseTool):
    name: str = "openheab_memory_search"
    description: str = "Semantic search over the agent's memory."
    args_schema: Type[BaseModel] = MemorySearchInput

    def __init__(self, identity, **kwargs):
        super().__init__(**kwargs)
        self._identity = identity

    def _run(self, query: str, k: int = 5) -> str:
        results = self._identity.client.memory.search(self._identity.did, query, k=k)
        if not results: return "No matching memories."
        return "\n".join(f"{i+1}. {str(r)[:200]}" for i, r in enumerate(results))


def create_openheab_tools(identity) -> List[BaseTool]:
    return [
        OpenHeabWalletBalanceTool(identity=identity),
        OpenHeabWalletTransferTool(identity=identity),
        OpenHeabEmailSendTool(identity=identity),
        OpenHeabKycVerifyTool(identity=identity),
        OpenHeabMemorySearchTool(identity=identity),
    ]
