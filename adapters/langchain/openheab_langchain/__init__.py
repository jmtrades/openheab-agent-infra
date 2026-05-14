"""OpenHeab adapter for LangChain — drop-in agent identity, wallet, email."""

from .identity import OpenHeabIdentity
from .tools import (
    create_openheab_tools,
    OpenHeabWalletBalanceTool,
    OpenHeabWalletTransferTool,
    OpenHeabEmailSendTool,
    OpenHeabKycVerifyTool,
    OpenHeabMemorySearchTool,
)

__version__ = "0.1.0"
__all__ = [
    "OpenHeabIdentity", "create_openheab_tools",
    "OpenHeabWalletBalanceTool", "OpenHeabWalletTransferTool",
    "OpenHeabEmailSendTool", "OpenHeabKycVerifyTool", "OpenHeabMemorySearchTool",
]
