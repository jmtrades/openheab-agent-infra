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


class BankModule(_Module):
    """Unified bank account view + statements + reconciliation + sweep."""
    def account(self, did: str, fast: bool = False):
        path = f"/v1/agents/{did}/bank" + ("?fast=1" if fast else "")
        status, body, _ = self.c._request("GET", path)
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def statement(self, did: str, *, from_date: Optional[str] = None,
                  to_date: Optional[str] = None, fmt: str = "json"):
        qs = []
        if from_date: qs.append(f"from={from_date}")
        if to_date:   qs.append(f"to={to_date}")
        if fmt:       qs.append(f"format={fmt}")
        path = f"/v1/agents/{did}/bank/statement"
        if qs: path += "?" + "&".join(qs)
        status, body, _ = self.c._request("GET", path)
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def deposits(self, did: str, limit: int = 50):
        status, body, _ = self.c._request("GET",
            f"/v1/agents/{did}/bank/deposits?limit={limit}")
        if status >= 300: raise OpenHeabError(status, body)
        return body.get("deposits", [])

    def reconcile(self, did: str):
        status, body, _ = self.c._request("POST", f"/v1/agents/{did}/bank/reconcile")
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def sweep(self, did: str, *, from_: str, to: str, amount_cents: int,
              savings_account_id: Optional[str] = None,
              loan_id: Optional[str] = None):
        payload = {"from": from_, "to": to, "amount_cents": amount_cents}
        if savings_account_id: payload["savings_account_id"] = savings_account_id
        if loan_id:            payload["loan_id"] = loan_id
        status, body, _ = self.c._request("POST",
            f"/v1/agents/{did}/bank/sweep", payload)
        if status >= 300: raise OpenHeabError(status, body)
        return body


class CardsModule(_Module):
    def issue(self, did: str, *, kind: str = "virtual",
              monthly_limit_cents: Optional[int] = None,
              per_tx_limit_cents: Optional[int] = None,
              shipping_address: Optional[Dict[str, Any]] = None):
        payload: Dict[str, Any] = {"kind": kind}
        if monthly_limit_cents is not None: payload["monthly_limit_cents"] = monthly_limit_cents
        if per_tx_limit_cents is not None:  payload["per_tx_limit_cents"] = per_tx_limit_cents
        if shipping_address:                payload["shipping_address"] = shipping_address
        status, body, _ = self.c._request("POST", f"/v1/agents/{did}/cards", payload)
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def list(self, did: str):
        status, body, _ = self.c._request("GET", f"/v1/agents/{did}/cards")
        if status >= 300: raise OpenHeabError(status, body)
        return body.get("cards", [])

    def freeze(self, did: str, card_id: str):
        status, body, _ = self.c._request("POST", f"/v1/agents/{did}/cards/{card_id}/freeze")
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def cancel(self, did: str, card_id: str):
        status, body, _ = self.c._request("POST", f"/v1/agents/{did}/cards/{card_id}/cancel")
        if status >= 300: raise OpenHeabError(status, body)
        return body


class SavingsModule(_Module):
    def open(self, did: str, *, strategy: str = "aave_v3",
             auto_compound: bool = True, lock_until: Optional[str] = None):
        payload: Dict[str, Any] = {"strategy": strategy, "auto_compound": auto_compound}
        if lock_until: payload["lock_until"] = lock_until
        status, body, _ = self.c._request("POST",
            f"/v1/agents/{did}/savings/accounts", payload)
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def list(self, did: str):
        status, body, _ = self.c._request("GET", f"/v1/agents/{did}/savings/accounts")
        if status >= 300: raise OpenHeabError(status, body)
        return body.get("accounts", [])

    def deposit(self, did: str, account_id: str, amount_raw: str):
        status, body, _ = self.c._request("POST",
            f"/v1/agents/{did}/savings/accounts/{account_id}/deposit",
            {"amount_raw": amount_raw})
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def withdraw(self, did: str, account_id: str, amount_raw: str):
        status, body, _ = self.c._request("POST",
            f"/v1/agents/{did}/savings/accounts/{account_id}/withdraw",
            {"amount_raw": amount_raw})
        if status >= 300: raise OpenHeabError(status, body)
        return body


class InferenceModule(_Module):
    def chat(self, did: str, *, model: str, messages: List[Dict[str, Any]],
             max_tokens: Optional[int] = None, temperature: Optional[float] = None):
        payload: Dict[str, Any] = {"model": model, "messages": messages}
        if max_tokens is not None:  payload["max_tokens"] = max_tokens
        if temperature is not None: payload["temperature"] = temperature
        status, body, _ = self.c._request("POST",
            f"/v1/agents/{did}/inference/chat", payload)
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def embeddings(self, did: str, *, model: str, input: List[str]):
        status, body, _ = self.c._request("POST",
            f"/v1/agents/{did}/inference/embeddings",
            {"model": model, "input": input})
        if status >= 300: raise OpenHeabError(status, body)
        return body


class InboxModule(_Module):
    def list(self, did: str, *, status_filter: Optional[str] = None, limit: int = 50):
        path = f"/v1/agents/{did}/inbox?limit={limit}"
        if status_filter: path += f"&status={status_filter}"
        status, body, _ = self.c._request("GET", path)
        if status >= 300: raise OpenHeabError(status, body)
        return body.get("envelopes", [])

    def send(self, *, sender_did: str, recipient_did: str,
             body_plain: Optional[str] = None,
             body_structured: Optional[Dict[str, Any]] = None,
             subject: Optional[str] = None):
        payload: Dict[str, Any] = {"sender_did": sender_did}
        if body_plain:      payload["body_plain"] = body_plain
        if body_structured: payload["body_structured"] = body_structured
        if subject:         payload["subject"] = subject
        status, body, _ = self.c._request("POST",
            f"/v1/agents/{recipient_did}/inbox/receive", payload)
        if status >= 300: raise OpenHeabError(status, body)
        return body


class ReputationModule(_Module):
    def get(self, did: str):
        status, body, _ = self.c._request("GET", f"/v1/agents/{did}/reputation")
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def vouch(self, did: str, *, target_did: str, score: float, reason: Optional[str] = None):
        payload: Dict[str, Any] = {"target_did": target_did, "score": score}
        if reason: payload["reason"] = reason
        status, body, _ = self.c._request("POST",
            f"/v1/agents/{did}/reputation/vouch", payload)
        if status >= 300: raise OpenHeabError(status, body)
        return body


class OrgModule(_Module):
    def create(self, *, name: str, slug: Optional[str] = None,
               kind: str = "company", owner_did: str,
               billing_email: Optional[str] = None):
        payload: Dict[str, Any] = {"name": name, "kind": kind, "owner_did": owner_did}
        if slug:          payload["slug"] = slug
        if billing_email: payload["billing_email"] = billing_email
        status, body, _ = self.c._request("POST", "/v1/orgs", payload)
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def get(self, org_id: str):
        status, body, _ = self.c._request("GET", f"/v1/orgs/{org_id}")
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def members(self, org_id: str):
        status, body, _ = self.c._request("GET", f"/v1/orgs/{org_id}/members")
        if status >= 300: raise OpenHeabError(status, body)
        return body.get("members", [])

    def invite(self, org_id: str, *, email: str, role: str = "member"):
        status, body, _ = self.c._request("POST",
            f"/v1/orgs/{org_id}/invites", {"email": email, "role": role})
        if status >= 300: raise OpenHeabError(status, body)
        return body


class SubscriptionsModule(_Module):
    def plans(self):
        status, body, _ = self.c._request("GET", "/v1/subscriptions/plans")
        if status >= 300: raise OpenHeabError(status, body)
        return body.get("plans", [])

    def subscribe(self, org_id: str, *, plan_code: str,
                  trial_days: Optional[int] = None,
                  payment_method_id: Optional[str] = None):
        payload: Dict[str, Any] = {"plan_code": plan_code}
        if trial_days is not None:    payload["trial_days"] = trial_days
        if payment_method_id:         payload["payment_method_id"] = payment_method_id
        status, body, _ = self.c._request("POST",
            f"/v1/orgs/{org_id}/subscription", payload)
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def current(self, org_id: str):
        status, body, _ = self.c._request("GET", f"/v1/orgs/{org_id}/subscription")
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def upgrade(self, org_id: str, new_plan_code: str):
        status, body, _ = self.c._request("POST",
            f"/v1/orgs/{org_id}/subscription/upgrade", {"new_plan_code": new_plan_code})
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def cancel(self, org_id: str, *, at_period_end: bool = True):
        status, body, _ = self.c._request("POST",
            f"/v1/orgs/{org_id}/subscription/cancel", {"at_period_end": at_period_end})
        if status >= 300: raise OpenHeabError(status, body)
        return body


class CreditsModule(_Module):
    def packs(self):
        status, body, _ = self.c._request("GET", "/v1/credits/packs")
        if status >= 300: raise OpenHeabError(status, body)
        return body.get("packs", [])

    def purchase(self, org_id: str, pack_code: str, payment_method_id: Optional[str] = None):
        payload: Dict[str, Any] = {"pack_code": pack_code}
        if payment_method_id: payload["payment_method_id"] = payment_method_id
        status, body, _ = self.c._request("POST",
            f"/v1/orgs/{org_id}/credits/purchase", payload)
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def balance(self, org_id: str):
        status, body, _ = self.c._request("GET", f"/v1/orgs/{org_id}/credits/balance")
        if status >= 300: raise OpenHeabError(status, body)
        return body


class OnboardingModule(_Module):
    def start(self, did: str, *, source: str = "sdk_python",
              utm_source: Optional[str] = None, org_id: Optional[str] = None):
        payload: Dict[str, Any] = {"source": source}
        if utm_source: payload["utm_source"] = utm_source
        if org_id:     payload["org_id"] = org_id
        status, body, _ = self.c._request("POST",
            f"/v1/agents/{did}/onboarding/start", payload)
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def state(self, did: str):
        status, body, _ = self.c._request("GET", f"/v1/agents/{did}/onboarding")
        if status >= 300: raise OpenHeabError(status, body)
        return body

    def complete(self, did: str, step_code: str, evidence_payload: Optional[Dict[str, Any]] = None):
        payload: Dict[str, Any] = {"step_code": step_code}
        if evidence_payload: payload["evidence_payload"] = evidence_payload
        status, body, _ = self.c._request("POST",
            f"/v1/agents/{did}/onboarding/complete", payload)
        if status >= 300: raise OpenHeabError(status, body)
        return body


class OpenHeab:
    """OpenHeab substrate client. Bearer auth via use_api_key()."""

    def __init__(self, base_url: str = "https://openheab.com", api_key: Optional[str] = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

        # Core
        self.identity = IdentityModule(self)
        self.wallet = WalletModule(self)
        self.bank = BankModule(self)
        self.cards = CardsModule(self)
        self.savings = SavingsModule(self)
        self.email = EmailModule(self)
        self.kyc = KycModule(self)
        self.memory = MemoryModule(self)
        self.audit = AuditModule(self)
        self.extensions = ExtensionsModule(self)

        # Cognition + comms
        self.inference = InferenceModule(self)
        self.inbox = InboxModule(self)
        self.reputation = ReputationModule(self)

        # Org / billing / commerce ops
        self.org = OrgModule(self)
        self.subscriptions = SubscriptionsModule(self)
        self.credits = CreditsModule(self)
        self.onboarding = OnboardingModule(self)

    def use_api_key(self, key: str) -> None:
        self.api_key = key

    def _request(self, method: str, path: str, body: Any = None,
                 headers: Optional[Dict[str, str]] = None):
        h = dict(headers or {})
        if self.api_key and "authorization" not in {k.lower() for k in h}:
            h["authorization"] = f"Bearer {self.api_key}"
        return _request(method, self.base_url + path, body, h)
