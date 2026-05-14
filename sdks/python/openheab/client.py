"""OpenHeab Python client (stdlib only — no external deps)."""

from __future__ import annotations

import os
import json
import urllib.request
import urllib.error
from dataclasses import dataclass
from typing import Any, Optional, Dict, List


class OpenHeabError(Exception):
    def __init__(self, status: int, body: Any):
        super().__init__(f"HTTP {status}: {str(body)[:200]}")
        self.status = status
        self.body = body


@dataclass
class Identity:
    did: str
    public_key: str
    private_key: Optional[str] = None
    api_key: Optional[str] = None
    wallet: Optional[Dict[str, Any]] = None


@dataclass
class WalletBalance:
    agent_did: str
    chain: str
    address: str
    asset: str
    balance: str
    balance_raw: str


@dataclass
class BankTransfer:
    tx_hash: str
    from_address: str
    to_address: str
    gross: str
    fee_raw: str
    net_raw: str
    chain: str
    status: str
    audit_hash: Optional[str]


def _request(method: str, url: str, body: Any = None,
             headers: Optional[Dict[str, str]] = None, timeout: int = 30):
    data = None
    h = {"content-type": "application/json", **(headers or {})}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
        resp_headers = {k.lower(): v for k, v in e.headers.items()}
    try:
        parsed = json.loads(raw.decode("utf-8")) if raw else None
    except (json.JSONDecodeError, UnicodeDecodeError):
        parsed = raw.decode("utf-8", errors="replace") if raw else None
    return status, parsed, resp_headers


class _Module:
    def __init__(self, client: "OpenHeab"):
        self.c = client


class IdentityModule(_Module):
    def create(self, **metadata) -> Identity:
        status, body, _ = self.c._request("POST", "/v1/identities", metadata)
        if status >= 300:
            raise OpenHeabError(status, body)
        return Identity(**{k: body.get(k) for k in
                          ["did", "public_key", "private_key", "api_key", "wallet"]})

    def get(self, did: str) -> Dict[str, Any]:
        status, body, _ = self.c._request("GET", f"/v1/identities/{did}")
        if status >= 300:
            raise OpenHeabError(status, body)
        return body


class WalletModule(_Module):
    def provision(self, did: str):
        status, body, _ = self.c._request("POST", f"/v1/agents/{did}/wallet/provision")
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def balance(self, did: str) -> WalletBalance:
        status, body, _ = self.c._request("GET", f"/v1/agents/{did}/wallet/balance")
        if status >= 300: raise OpenHeabError(status, body)
        return WalletBalance(**{k: body.get(k) for k in
                                ["agent_did", "chain", "address", "asset", "balance", "balance_raw"]})

    def transfer(self, did: str, *, to_did: Optional[str] = None,
                 to_address: Optional[str] = None, amount_usdc: str,
                 reason: Optional[str] = None,
                 idempotency_key: Optional[str] = None) -> BankTransfer:
        body = {"amount_usdc": amount_usdc}
        if to_did:     body["to_did"] = to_did
        if to_address: body["to_address"] = to_address
        if reason:     body["reason"] = reason
        h = {"x-idempotency-key": idempotency_key} if idempotency_key else None
        status, resp, _ = self.c._request("POST", f"/v1/agents/{did}/wallet/transfer", body, headers=h)
        if status >= 300: raise OpenHeabError(status, resp)
        return BankTransfer(**{k: resp.get(k) for k in
                               ["tx_hash", "from_address", "to_address", "gross",
                                "fee_raw", "net_raw", "chain", "status", "audit_hash"]})

    def transactions(self, did: str, limit: int = 50) -> List[Dict[str, Any]]:
        status, body, _ = self.c._request("GET",
            f"/v1/agents/{did}/wallet/transactions?limit={limit}")
        if status >= 300: raise OpenHeabError(status, body)
        return body.get("transactions", [])


class EmailModule(_Module):
    def claim_address(self, did: str, local_part: str):
        status, body, _ = self.c._request("POST",
            f"/v1/agents/{did}/email/address", {"local_part": local_part})
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def send(self, did: str, *, to: str, subject: Optional[str] = None,
             body_text: Optional[str] = None, body_html: Optional[str] = None,
             cc: Optional[List[str]] = None, in_reply_to: Optional[str] = None):
        payload = {"to": to}
        if subject:     payload["subject"] = subject
        if body_text:   payload["body_text"] = body_text
        if body_html:   payload["body_html"] = body_html
        if cc:          payload["cc"] = cc
        if in_reply_to: payload["in_reply_to"] = in_reply_to
        status, body, _ = self.c._request("POST", f"/v1/agents/{did}/email/send", payload)
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def list(self, did: str, direction: str = "in", limit: int = 50):
        status, body, _ = self.c._request("GET",
            f"/v1/agents/{did}/email/messages?direction={direction}&limit={limit}")
        if status >= 300: raise OpenHeabError(status, body)
        return body.get("messages", [])


class KycModule(_Module):
    def submit_claim(self, did: str, *, claim_type: str, claim_value: str):
        status, body, _ = self.c._request("POST",
            f"/v1/agents/{did}/kyc/claims",
            {"claim_type": claim_type, "claim_value": claim_value})
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def verify(self, did: str):
        status, body, _ = self.c._request("GET", f"/v1/agents/{did}/kyc/verify")
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def tier(self, did: str):
        status, body, _ = self.c._request("GET", f"/v1/agents/{did}/kyc/tier")
        if status >= 300: raise OpenHeabError(status, body)
        return body


class MemoryModule(_Module):
    def kv_put(self, did: str, key: str, value: Any, ttl_seconds: Optional[int] = None):
        body = {"value": value}
        if ttl_seconds: body["ttl_seconds"] = ttl_seconds
        status, resp, _ = self.c._request("PUT",
            f"/v1/agents/{did}/memory/kv/{key}", body)
        if status >= 300: raise OpenHeabError(status, resp)
        return resp

    def kv_get(self, did: str, key: str):
        status, body, _ = self.c._request("GET", f"/v1/agents/{did}/memory/kv/{key}")
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def search(self, did: str, query: str, k: int = 10):
        status, body, _ = self.c._request("POST",
            f"/v1/agents/{did}/memory/search", {"query": query, "k": k})
        if status >= 300: raise OpenHeabError(status, body)
        return body.get("results", [])


class AuditModule(_Module):
    def verify(self, limit: int = 1000):
        status, body, _ = self.c._request("GET", f"/v1/audit/verify?limit={limit}")
        if status >= 300: raise OpenHeabError(status, body)
        return body


class ExtensionsModule(_Module):
    def list(self, **filters):
        qs = "&".join(f"{k}={v}" for k, v in filters.items())
        path = "/v1/extensions" + (f"?{qs}" if qs else "")
        status, body, _ = self.c._request("GET", path)
        if status >= 300: raise OpenHeabError(status, body)
        return body.get("extensions", [])

    def invoke(self, slug: str, *, caller_did: str, input_data: Optional[Dict[str, Any]] = None):
        status, body, _ = self.c._request("POST", f"/v1/extensions/{slug}/invoke",
                                          {"input": input_data or {}},
                                          headers={"x-agent-did": caller_did})
        if status >= 300: raise OpenHeabError(status, body)
        return body


class OpenHeab:
    """OpenHeab substrate client. Bearer auth via use_api_key()."""

    def __init__(self, base_url: str = "https://openheab.com", api_key: Optional[str] = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

        self.identity = IdentityModule(self)
        self.wallet = WalletModule(self)
        self.email = EmailModule(self)
        self.kyc = KycModule(self)
        self.memory = MemoryModule(self)
        self.audit = AuditModule(self)
        self.extensions = ExtensionsModule(self)

    def use_api_key(self, key: str) -> None:
        self.api_key = key

    def _request(self, method: str, path: str, body: Any = None,
                 headers: Optional[Dict[str, str]] = None):
        h = dict(headers or {})
        if self.api_key and "authorization" not in {k.lower() for k in h}:
            h["authorization"] = f"Bearer {self.api_key}"
        return _request(method, self.base_url + path, body, h)
