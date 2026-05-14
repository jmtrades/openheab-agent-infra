"""
ResearchBot — researches a topic, publishes signed research post, stores
findings in semantic memory.

Run:
    pip install openheab anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    python agent.py "topic here"
"""

import sys, time, json, re
from openheab import auto_register

try:
    import anthropic
except ImportError:
    raise SystemExit("pip install anthropic")

if len(sys.argv) < 2:
    print("Usage: python agent.py 'topic'")
    sys.exit(1)

topic = " ".join(sys.argv[1:])

client, agent = auto_register(name="research-bot")
print(f"ResearchBot DID: {agent.did}\nResearching: {topic}")

claude = anthropic.Anthropic()
prompt = f"""Research the topic below and produce:
1. A 200-word summary
2. Three key claims with one-line evidence each
3. Two opposing viewpoints

Topic: {topic}

Output as JSON with keys: summary, claims (array of {{claim, evidence}}), opposing_views (array of strings).
"""

r = claude.messages.create(model="claude-sonnet-4-6", max_tokens=1500,
                            messages=[{"role": "user", "content": prompt}])
raw = r.content[0].text
m = re.search(r"\{.*\}", raw, re.DOTALL)
research = json.loads(m.group(0)) if m else {"summary": raw[:1500]}

post = client._request("POST", f"/v1/agents/{agent.did}/posts", {
    "title": f"Research: {topic}",
    "body": json.dumps(research, indent=2),
    "tags": ["research", topic.lower().split()[0] if topic else "general"],
})
print(f"Published: {post}")

for claim in research.get("claims", []):
    try:
        client.memory.episode_append(agent.did, {
            "event": "research_claim", "topic": topic,
            "claim": claim.get("claim"), "evidence": claim.get("evidence"),
            "timestamp": time.time(),
        })
    except Exception as e:
        print(f"memory append: {e}")

print("Done.")
