"""
NegotiationBot — escrow-mediated dealmaking between two agents.

Run:
    pip install openheab anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    python agent.py negotiate --counterparty did:op:seller... --max-budget 100 --item "5000 widgets" --opening 25
"""

import argparse, json, re, time
from openheab import auto_register, OpenHeabError

try:
    import anthropic
except ImportError:
    raise SystemExit("pip install anthropic")


def _generate_counter(claude, history, max_budget, item):
    prompt = f"""Negotiating to buy: {item}
Max budget: ${max_budget} USDC
History: {json.dumps(history, indent=2)}

Output JSON: {{"action": "counter"|"accept"|"walk", "amount_usdc": "...", "rationale": "..."}}
Rules: never exceed max_budget. Walk after 4 rounds at refusal. Output JSON only."""
    r = claude.messages.create(model="claude-sonnet-4-6", max_tokens=400,
                                messages=[{"role": "user", "content": prompt}])
    text = r.content[0].text
    m = re.search(r"\{[\s\S]*\}", text)
    if not m: return {"action": "walk", "rationale": "couldn't parse"}
    try: return json.loads(m.group(0))
    except json.JSONDecodeError: return {"action": "walk", "rationale": "invalid JSON"}


def negotiate(args):
    client, agent = auto_register(name="negotiation-bot")
    did = agent.did
    claude = anthropic.Anthropic()

    history = []
    if args.opening:
        history.append({"from": "us", "offer_usdc": args.opening, "round": 1})
        client._request("POST", f"/v1/agents/{args.counterparty}/inbox/receive", {
            "sender_did": did, "body": {"type": "structured", "structured": {
                "intent": "negotiation.offer", "item": args.item,
                "amount_usdc": args.opening, "round": 1,
            }},
        }, headers={"x-agent-did": did})
        print(f"Sent opening offer: ${args.opening}")

    deadline = time.time() + args.timeout_minutes * 60
    while time.time() < deadline and len(history) < args.max_rounds:
        time.sleep(args.poll_seconds)
        msgs = client._request("GET", f"/v1/agents/{did}/inbox?status=pending&limit=20")[1]
        new_offers = []
        for env in msgs.get("envelopes", []):
            if env.get("sender_did") != args.counterparty: continue
            body = env.get("body_structured") or {}
            if body.get("intent") in ("negotiation.offer", "negotiation.counter"):
                new_offers.append(body)
                client._request("POST", f"/v1/agents/{did}/inbox/{env['envelope_id']}/ack",
                                None, headers={"x-agent-did": did})

        for offer in new_offers:
            history.append({"from": "them", "offer_usdc": offer.get("amount_usdc"),
                            "round": offer.get("round")})
            decision = _generate_counter(claude, history, args.max_budget, args.item)
            print(f"\nRound {len(history)}: {decision}")

            if decision["action"] == "accept":
                amount = offer.get("amount_usdc")
                amount_raw = int(float(amount) * 1_000_000)
                print(f"ACCEPTED at ${amount}.")
                return
            elif decision["action"] == "walk":
                print(f"WALKED. {decision.get('rationale')}")
                return
            else:
                history.append({"from": "us", "offer_usdc": decision["amount_usdc"],
                                "round": len(history) + 1})
                print(f"Countered with ${decision['amount_usdc']}")

    print("Timeout reached.")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["negotiate"])
    p.add_argument("--counterparty", required=True)
    p.add_argument("--max-budget", type=float, required=True)
    p.add_argument("--item", required=True)
    p.add_argument("--opening", type=float, default=None)
    p.add_argument("--max-rounds", type=int, default=10)
    p.add_argument("--timeout-minutes", type=int, default=30)
    p.add_argument("--poll-seconds", type=int, default=10)
    args = p.parse_args()
    negotiate(args)
