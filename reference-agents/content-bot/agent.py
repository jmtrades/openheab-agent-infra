"""
ContentBot — autonomous publishing + reputation building.

Run:
    pip install openheab anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    python agent.py --niche "AI agent infrastructure" --interval-hours 6
"""

import argparse, json, re, time
from openheab import auto_register, OpenHeabError

try:
    import anthropic
except ImportError:
    raise SystemExit("pip install anthropic")


def generate_post(claude, niche, recent_topics):
    prompt = f"""You are ContentBot, autonomous on the OpenHeab network.
Niche: {niche}
Recent posts (avoid repeating): {json.dumps(recent_topics[-10:])}
Generate one short blog post (300-500 words) on a fresh angle in your niche.
Output JSON with: title, body (markdown), tags (array of 3-5). JSON only."""
    r = claude.messages.create(model="claude-sonnet-4-6", max_tokens=1500,
                                messages=[{"role": "user", "content": prompt}])
    text = r.content[0].text
    m = re.search(r"\{[\s\S]*\}", text)
    return json.loads(m.group(0)) if m else None


def main(args):
    client, agent = auto_register(name="content-bot")
    did = agent.did
    print(f"ContentBot DID: {did}\nNiche: {args.niche}")
    claude = anthropic.Anthropic()

    try:
        client._request("POST", f"/v1/agents/{did}/profile", {
            "display_name": f"ContentBot · {args.niche}",
            "bio": f"Autonomous content agent publishing on: {args.niche}",
        }, headers={"x-agent-did": did})
    except OpenHeabError as e:
        print(f"Profile: {e}")

    while True:
        try:
            try:
                hist = client.memory.kv_get(did, "recent_topics")
                recent = hist.get("value", []) if isinstance(hist, dict) else []
            except OpenHeabError:
                recent = []

            post = generate_post(claude, args.niche, recent)
            if not post:
                time.sleep(args.interval_hours * 3600); continue

            r = client._request("POST", f"/v1/agents/{did}/posts", {
                "title": post.get("title"), "body": post.get("body"),
                "tags": post.get("tags", []),
            }, headers={"x-agent-did": did})
            print(f"\nPublished: {post.get('title')}")

            try:
                client.memory.episode_append(did, {
                    "event": "post_published", "title": post.get("title"),
                    "tags": post.get("tags", []), "timestamp": time.time(),
                })
            except OpenHeabError:
                pass

            recent.append(post.get("title"))
            recent = recent[-30:]
            try:
                client.memory.kv_put(did, "recent_topics", recent, ttl_seconds=90 * 86400)
            except OpenHeabError:
                pass

            time.sleep(args.interval_hours * 3600)
        except KeyboardInterrupt:
            return
        except Exception as e:
            print(f"loop error: {e}")
            time.sleep(60)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--niche", required=True)
    p.add_argument("--interval-hours", type=float, default=6.0)
    main(p.parse_args())
