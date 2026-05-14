"""
ComplianceBot — pre-transaction screening (KYC + reputation + sanctions).

Run:
    pip install openheab
    python agent.py check did:op:counterparty... 500.00
    python agent.py serve  # publishes extension + serves invocations via flask
"""

import sys, json
from dataclasses import dataclass
from typing import Optional
from openheab import auto_register, OpenHeabError


@dataclass
class ComplianceCheck:
    verdict: str       # clear | flagged | warn | unknown
    reason: str
    details: dict

    @classmethod
    def check(cls, client, our_did, counterparty_did, amount_usdc=None):
        details = {}
        try:
            kyc = client.kyc.verify(counterparty_did)
            details["kyc"] = {
                "result": kyc.get("result"),
                "sanctions_matches": len(kyc.get("sanctions_matches") or []),
                "claims_count": len((kyc.get("claims") or {})),
            }
            if kyc.get("result") == "flagged":
                return cls("flagged", "counterparty has sanctions matches", details)
        except OpenHeabError as e:
            details["kyc_error"] = str(e)
        try:
            rep = client._request("GET", f"/v1/reputation/{counterparty_did}")[1]
            score = (rep or {}).get("score")
            details["reputation_score"] = score
            if score is not None and score < 0.3:
                return cls("warn", f"low reputation score: {score:.2f}", details)
        except OpenHeabError:
            details["reputation"] = "unknown"
        if not details.get("kyc"):
            return cls("unknown", "could not run KYC verify", details)
        return cls("clear", "all checks passed", details)


def cli_check(counterparty_did, amount):
    client, agent = auto_register(name="compliance-bot")
    result = ComplianceCheck.check(client, agent.did, counterparty_did, amount)
    print(json.dumps({
        "verdict": result.verdict, "reason": result.reason,
        "details": result.details,
    }, indent=2, default=str))


def serve():
    from flask import Flask, request, jsonify
    client, agent = auto_register(name="compliance-bot")
    app = Flask(__name__)

    @app.post("/invoke")
    def invoke():
        body = request.get_json() or {}
        inp = body.get("input") or {}
        if not inp.get("counterparty_did"):
            return jsonify({"error": "counterparty_did required"}), 400
        result = ComplianceCheck.check(client, agent.did,
                                       inp["counterparty_did"],
                                       inp.get("amount_usdc"))
        return jsonify({
            "verdict": result.verdict, "reason": result.reason,
            "details": result.details,
        })

    print("Listening on :5051")
    app.run(host="0.0.0.0", port=5051)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python agent.py [check DID AMOUNT | serve]")
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "check" and len(sys.argv) >= 4:
        cli_check(sys.argv[2], sys.argv[3])
    elif cmd == "serve":
        serve()
    else:
        print("Usage: python agent.py [check DID AMOUNT | serve]")
