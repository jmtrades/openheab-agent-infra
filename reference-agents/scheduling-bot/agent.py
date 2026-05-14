"""
SchedulingBot — calendar agent that books meetings over email.

Run:
    pip install openheab anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    python agent.py
"""

import json, re, time, uuid
from datetime import datetime, timedelta, timezone
from openheab import auto_register, OpenHeabError

try:
    import anthropic
except ImportError:
    raise SystemExit("pip install anthropic")

POLL_SEC = 30
WORKING_HOURS = (9, 18)

client, agent = auto_register(name="scheduling-bot")
DID = agent.did
print(f"SchedulingBot DID: {DID}")

try:
    addr = client.email.claim_address(DID, "calendar")
    print(f"Email: {addr.get('address')}")
except OpenHeabError as e:
    print(f"Email claim: {e}")


def _get_calendar():
    try:
        cal = client.memory.kv_get(DID, "calendar")
        return cal.get("value", {"events": []}) if isinstance(cal, dict) else {"events": []}
    except OpenHeabError:
        return {"events": []}


def _save_calendar(cal):
    try:
        client.memory.kv_put(DID, "calendar", cal, ttl_seconds=30 * 86400)
    except OpenHeabError as e:
        print(f"calendar save: {e}")


claude = anthropic.Anthropic()
seen = set()


def parse_request(body):
    prompt = f"""Extract from this email:
- duration_minutes (default 30)
- earliest_iso, latest_iso (UTC; default tomorrow 09:00 to tomorrow 18:00)
- title (short, default "Meeting with [sender]")

Email: \"\"\"{body[:3000]}\"\"\"

Output JSON only."""
    r = claude.messages.create(model="claude-sonnet-4-6", max_tokens=300,
                                messages=[{"role": "user", "content": prompt}])
    text = r.content[0].text
    m = re.search(r"\{[\s\S]*\}", text)
    return json.loads(m.group(0)) if m else None


def find_slot(cal, duration_min, earliest, latest):
    events = sorted(
        [(datetime.fromisoformat(e["start"]).replace(tzinfo=timezone.utc),
          datetime.fromisoformat(e["end"]).replace(tzinfo=timezone.utc))
         for e in cal["events"]], key=lambda x: x[0])
    cursor = earliest.replace(minute=(earliest.minute // 30) * 30, second=0, microsecond=0)
    dur = timedelta(minutes=duration_min)
    while cursor + dur <= latest:
        if cursor.hour < WORKING_HOURS[0] or cursor.hour + dur.total_seconds()/3600 > WORKING_HOURS[1]:
            cursor += timedelta(minutes=30); continue
        conflict = any(s <= cursor < e or s < cursor + dur <= e for s, e in events)
        if not conflict: return cursor, cursor + dur
        cursor += timedelta(minutes=30)
    return None, None


while True:
    try:
        messages = client.email.list(DID, direction="in", limit=20)
        for m in messages:
            mid = m["message_id"]
            if mid in seen: continue
            seen.add(mid)
            body = m.get("body_text") or m.get("body_html") or ""
            sender = m.get("from_address")
            print(f"\nFrom {sender}: {(m.get('subject') or '').strip()[:80]}")

            req = parse_request(body)
            if not req: continue

            cal = _get_calendar()
            now = datetime.now(timezone.utc)
            try:
                earliest = datetime.fromisoformat(req["earliest_iso"]).replace(tzinfo=timezone.utc)
                latest = datetime.fromisoformat(req["latest_iso"]).replace(tzinfo=timezone.utc)
            except (KeyError, ValueError):
                earliest = (now + timedelta(days=1)).replace(hour=9, minute=0)
                latest = earliest.replace(hour=18)

            start, end = find_slot(cal, req.get("duration_minutes", 30), earliest, latest)
            if not start:
                client.email.send(DID, to=sender,
                    subject=f"Re: {m.get('subject') or 'meeting'}",
                    body_text=f"No free slot. Suggest a wider window?")
                continue

            cal["events"].append({
                "start": start.isoformat(), "end": end.isoformat(),
                "title": req.get("title", f"Meeting with {sender}"),
                "with": sender, "booked_via_email": mid,
            })
            _save_calendar(cal)

            reply = f"Confirmed: {req.get('title', 'Meeting')}\nWhen: {start.strftime('%a %d %b %Y %H:%M UTC')} — {end.strftime('%H:%M UTC')}"
            client.email.send(DID, to=sender,
                subject=f"Confirmed: {req.get('title', 'meeting')}",
                body_text=reply, in_reply_to=mid)
            print(f"  booked {start.strftime('%Y-%m-%d %H:%M UTC')}")
    except Exception as e:
        print(f"loop error: {e}")
    time.sleep(POLL_SEC)
