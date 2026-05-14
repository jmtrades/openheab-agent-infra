"""
EmailBot — autonomous email triage. Reads inbox, classifies with Claude,
replies to questions, archives the rest.

Run:
    pip install openheab anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    python agent.py
"""

import os, time, json, re
from openheab import auto_register

try:
    import anthropic
except ImportError:
    raise SystemExit("pip install anthropic")

POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL_SEC", "30"))

client, agent = auto_register(name="email-bot")
try:
    addr = client.email.claim_address(agent.did, "hello")
    print(f"Email address: {addr.get('address')}")
except Exception as e:
    print(f"Address claim: {e}")

claude = anthropic.Anthropic()
seen = set()


def classify_and_reply(msg):
    body = msg.get("body_text") or msg.get("body_html") or ""
    if not body: return None
    prompt = f"""You are an autonomous email assistant. Given the email below,
output JSON with: action ("reply" | "ignore" | "forward"), and if action is
"reply", a `text` field with a short courteous reply (<150 words).

FROM: {msg.get('from_address')}
SUBJECT: {msg.get('subject') or '(no subject)'}
BODY: {body[:4000]}

Output JSON only."""
    r = claude.messages.create(model="claude-sonnet-4-6", max_tokens=600,
                                messages=[{"role": "user", "content": prompt}])
    text = r.content[0].text
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m: return None
    try: return json.loads(m.group(0))
    except json.JSONDecodeError: return None


print(f"EmailBot running. DID={agent.did}\nPolling every {POLL_INTERVAL}s...")

while True:
    try:
        messages = client.email.list(agent.did, direction="in", limit=20)
        for m in messages:
            if m["message_id"] in seen: continue
            seen.add(m["message_id"])
            print(f"\n→ {m['from_address']}: {m.get('subject') or '(no subject)'}")
            decision = classify_and_reply(m)
            if not decision: continue
            print(f"  action={decision['action']}")
            if decision["action"] == "reply" and decision.get("text"):
                client.email.send(agent.did, to=m["from_address"],
                    subject=f"Re: {m.get('subject') or 'your message'}",
                    body_text=decision["text"], in_reply_to=m["message_id"])
                print(f"  reply sent")
    except Exception as e:
        print(f"loop error: {e}")
    time.sleep(POLL_INTERVAL)
