"""openheab CLI — `openheab agent create`, `openheab balance`, etc."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
from typing import Any, Optional

from .auto import auto_register, DEFAULT_CRED_PATH
from .client import OpenHeab, OpenHeabError

VERSION = "0.1.0"


def _client_with_identity() -> tuple[OpenHeab, str]:
    cpath = pathlib.Path(os.environ.get("OPENHEAB_CREDENTIALS", DEFAULT_CRED_PATH))
    if os.environ.get("OPENHEAB_API_KEY") and os.environ.get("OPENHEAB_DID"):
        client = OpenHeab(
            base_url=os.environ.get("OPENHEAB_BASE_URL", "https://openheab.com"),
            api_key=os.environ["OPENHEAB_API_KEY"],
        )
        return client, os.environ["OPENHEAB_DID"]
    if not cpath.exists():
        print("No credentials. Run: openheab agent create", file=sys.stderr)
        sys.exit(2)
    data = json.loads(cpath.read_text())
    client = OpenHeab(base_url=data.get("base_url", "https://openheab.com"), api_key=data["api_key"])
    return client, data["did"]


def _ok(obj: Any):
    print(json.dumps(obj, indent=2, default=str))


def _err(msg: str, code: int = 1):
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(code)


def cmd_agent_create(args):
    client, identity = auto_register(
        base_url=args.base_url or "https://openheab.com",
        name=args.name, cred_path=args.cred_path,
    )
    _ok({
        "did": identity.did, "wallet": identity.wallet,
        "credentials_saved_to": args.cred_path or DEFAULT_CRED_PATH,
        "next": "openheab balance",
    })


def cmd_agent_info(args):
    client, did = _client_with_identity()
    try: _ok(client.identity.get(did))
    except OpenHeabError as e: _err(f"lookup failed: {e}")


def cmd_whoami(args):
    cpath = pathlib.Path(os.environ.get("OPENHEAB_CREDENTIALS", DEFAULT_CRED_PATH))
    if cpath.exists():
        data = json.loads(cpath.read_text())
        _ok({"did": data.get("did"), "base_url": data.get("base_url"),
             "credentials_path": str(cpath)})
    else:
        _err("not logged in. Run: openheab agent create", code=2)


def cmd_logout(args):
    cpath = pathlib.Path(os.environ.get("OPENHEAB_CREDENTIALS", DEFAULT_CRED_PATH))
    if cpath.exists():
        cpath.unlink()
        _ok({"logged_out": True})
    else:
        _ok({"already_logged_out": True})


def cmd_balance(args):
    client, did = _client_with_identity()
    try:
        b = client.wallet.balance(did)
        _ok({"did": did, "chain": b.chain, "asset": b.asset,
             "address": b.address, "balance": b.balance, "balance_raw": b.balance_raw})
    except OpenHeabError as e: _err(f"balance check failed: {e}")


def cmd_transfer(args):
    client, did = _client_with_identity()
    to_did = args.to if args.to.startswith("did:op:") else None
    to_address = args.to if not to_did else None
    try:
        tx = client.wallet.transfer(did, to_did=to_did, to_address=to_address,
                                    amount_usdc=args.amount, reason=args.reason)
        _ok({"tx_hash": tx.tx_hash, "status": tx.status, "gross": tx.gross,
             "net_raw": tx.net_raw, "fee_raw": tx.fee_raw, "audit_hash": tx.audit_hash})
    except OpenHeabError as e: _err(f"transfer failed: {e}")


def cmd_audit_verify(args):
    client, _ = _client_with_identity()
    try: _ok(client.audit.verify(limit=args.limit))
    except OpenHeabError as e: _err(f"verify failed: {e}")


def cmd_email_claim(args):
    client, did = _client_with_identity()
    try: _ok(client.email.claim_address(did, args.local_part))
    except OpenHeabError as e: _err(f"claim failed: {e}")


def cmd_email_send(args):
    client, did = _client_with_identity()
    try:
        _ok(client.email.send(did, to=args.to, subject=args.subject, body_text=args.body))
    except OpenHeabError as e: _err(f"send failed: {e}")


def cmd_kyc_verify(args):
    client, did = _client_with_identity()
    try: _ok(client.kyc.verify(did))
    except OpenHeabError as e: _err(f"verify failed: {e}")


def build_parser():
    p = argparse.ArgumentParser(prog="openheab", description=f"OpenHeab CLI v{VERSION}")
    p.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    p.add_argument("--base-url", default=None)
    p.add_argument("--cred-path", default=None)
    sub = p.add_subparsers(dest="cmd", required=True)

    agent = sub.add_parser("agent")
    agent_sub = agent.add_subparsers(dest="agent_cmd", required=True)
    ac = agent_sub.add_parser("create"); ac.add_argument("--name", default=None); ac.set_defaults(func=cmd_agent_create)
    ai = agent_sub.add_parser("info"); ai.set_defaults(func=cmd_agent_info)

    sub.add_parser("whoami").set_defaults(func=cmd_whoami)
    sub.add_parser("logout").set_defaults(func=cmd_logout)
    sub.add_parser("balance").set_defaults(func=cmd_balance)

    t = sub.add_parser("transfer")
    t.add_argument("--to", required=True); t.add_argument("--amount", required=True)
    t.add_argument("--reason", default=None); t.set_defaults(func=cmd_transfer)

    email = sub.add_parser("email")
    email_sub = email.add_subparsers(dest="email_cmd", required=True)
    ec = email_sub.add_parser("claim"); ec.add_argument("local_part"); ec.set_defaults(func=cmd_email_claim)
    es = email_sub.add_parser("send"); es.add_argument("--to", required=True); es.add_argument("--subject", default=""); es.add_argument("--body", required=True); es.set_defaults(func=cmd_email_send)

    kyc = sub.add_parser("kyc")
    kyc_sub = kyc.add_subparsers(dest="kyc_cmd", required=True)
    kyc_sub.add_parser("verify").set_defaults(func=cmd_kyc_verify)

    aud = sub.add_parser("audit")
    aud_sub = aud.add_subparsers(dest="aud_cmd", required=True)
    av = aud_sub.add_parser("verify"); av.add_argument("--limit", type=int, default=1000); av.set_defaults(func=cmd_audit_verify)

    return p


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not hasattr(args, "func"):
        parser.print_help()
        sys.exit(1)
    args.func(args)


if __name__ == "__main__":
    main()
