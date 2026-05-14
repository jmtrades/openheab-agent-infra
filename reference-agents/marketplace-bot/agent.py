"""
MarketplaceBot — lists a service on the OpenHeab marketplace, accepts orders, delivers.

Run:
    pip install openheab
    python agent.py list "Translate Spanish to English" "0.50"
    python agent.py orders
    python agent.py deliver ORDER_ID "translated text"
"""

import sys, json
from openheab import auto_register, OpenHeabError

client, agent = auto_register(name="marketplace-bot")
DID = agent.did
print(f"MarketplaceBot DID: {DID}")


def cmd_list(title, price_usdc):
    try:
        listing = client.marketplace.create_listing({
            "seller_did": DID, "title": title,
            "description": "Automated service delivered by an OpenHeab agent.",
            "price_usdc": price_usdc, "category": "ai-services",
        }) if hasattr(client, 'marketplace') and hasattr(client.marketplace, 'create_listing') else client._request("POST", "/v1/marketplace/listings", {
            "seller_did": DID, "title": title,
            "description": "Automated service delivered by an OpenHeab agent.",
            "price_usdc": price_usdc, "category": "ai-services",
        })[1]
        print(f"Listed: {listing}")
    except OpenHeabError as e:
        print(f"List failed: {e.body}")


def cmd_orders():
    try:
        r = client._request("GET", f"/v1/marketplace/orders?seller_did={DID}")[1]
        orders = r.get("orders", [])
        if not orders: print("No orders yet."); return
        for o in orders:
            print(f"  order_id={o.get('order_id')} status={o.get('status')} buyer={o.get('buyer_did')}")
    except OpenHeabError as e:
        print(f"Orders: {e.body}")


def cmd_deliver(order_id, delivery_text):
    try:
        r = client._request("POST", f"/v1/marketplace/orders/{order_id}/deliver",
            {"delivery": delivery_text})[1]
        print(f"Delivered: {r}")
    except OpenHeabError as e:
        print(f"Deliver failed: {e.body}")


cmd = sys.argv[1] if len(sys.argv) > 1 else "orders"
if cmd == "list" and len(sys.argv) >= 4:
    cmd_list(sys.argv[2], sys.argv[3])
elif cmd == "orders":
    cmd_orders()
elif cmd == "deliver" and len(sys.argv) >= 4:
    cmd_deliver(sys.argv[2], " ".join(sys.argv[3:]))
else:
    print("Usage: python agent.py [list TITLE PRICE | orders | deliver ORDER_ID TEXT]")
