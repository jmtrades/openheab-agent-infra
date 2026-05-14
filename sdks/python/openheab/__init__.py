"""OpenHeab Python SDK — agent identity, bank, KYC, email, memory."""

from .client import OpenHeab, OpenHeabError, Identity, WalletBalance, BankTransfer
from .auto import auto_register

__version__ = "0.1.0"
__all__ = [
    "OpenHeab", "OpenHeabError",
    "Identity", "WalletBalance", "BankTransfer",
    "auto_register",
]
