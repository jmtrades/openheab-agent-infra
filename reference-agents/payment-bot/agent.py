"""
PaymentBot — splits incoming USDC across configured recipient DIDs.

Run:
    pip install openheab flask
    SPLIT='did:op:abc=60,did:op:def=40' python agent.py
"""

import os, json, hmac, hashlib
from openheab import auto_register

try:
    from flask import Flask, request, abort
except ImportError:
    raise SystemExit("pip install flask")

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "set-this")
SPLIT_SPEC = os.environ.get("SPLIT", "")
PORT = int(os.environ.get("PORT", "5050"))


def parse_split(s):
    parts = [p.strip() for p in s.split(",") if p.strip()]
    return [(did.strip(), int(w)) for p in parts for did, w in [p.split("=")]]


SPLITS = parse_split(SPLIT_SPEC) if SPLIT_SPEC else []
client, agent = auto_register(name="payment-bot")
print(f"PaymentBot DID: {agent.did}\nSplits: {SPLITS}")

try:
    webhook_url = f"{os.environ.get('PUBLIC_URL', 'http://localhost:5050')}/webhook"
    sub = client._request("POST", f"/v1/agents/{agent.did}/wallet/webhooks", {
        "url": webhook_url, "event_types": ["wallet.received"]
    })
    print(f"Webhook registered: {sub}")
except Exception as e:
    print(f"Webhook registration: {e}")

app = Flask(__name__)


@app.post("/webhook")
def webhook():
    sig_header = request.headers.get("openheab-signature", "")
    ts = request.headers.get("openheab-timestamp", "")
    body = request.get_data()
    expected = hmac.new(WEBHOOK_SECRET.encode(),
                       (ts + "." + body.decode("utf-8")).encode(),
                       hashlib.sha256).hexdigest()
    if f"v1={expected}" not in sig_header: abort(401)

    event = request.get_json()
    print(f"\nReceived: {event}")
    gross_raw = int(event.get("net_raw", 0))
    if gross_raw <= 0 or not SPLITS: return {"ok": True, "split": 0}

    total_weight = sum(w for _, w in SPLITS)
    splits_done = []
    for to_did, weight in SPLITS:
        share = (gross_raw * weight) // total_weight
        if share <= 0: continue
        amount_usdc = f"{share // 1_000_000}.{share % 1_000_000:06d}"
        try:
            tx = client.wallet.transfer(agent.did, to_did=to_did,
                amount_usdc=amount_usdc, reason=f"split {weight}/{total_weight}")
            splits_done.append({"to": to_did, "tx_hash": tx.tx_hash})
        except Exception as e:
            splits_done.append({"to": to_did, "error": str(e)})

    print(f"Split: {splits_done}")
    return {"ok": True, "splits": splits_done}


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
