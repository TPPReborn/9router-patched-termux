"""End-to-end probe through the local 9Router (bai/<model>) with a long timeout.
Uses the active API key from the DB (never printed). Reports account-state delta.
Usage: python3 scripts/probe-bai-long.py <model> [timeout_s]
"""
import json, sqlite3, sys, urllib.request, urllib.error, time

DB = "/home/agentuser/.9router/db/data.sqlite"
model = sys.argv[1] if len(sys.argv) > 1 else "glm-5.2"
tmo = int(sys.argv[2]) if len(sys.argv) > 2 else 600

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row
key = db.execute("SELECT key FROM apiKeys WHERE isActive=1 LIMIT 1").fetchone()[0]

POOL = "SELECT isActive, COUNT(*) n FROM providerConnections WHERE provider LIKE '%65f09875%' GROUP BY isActive"

def pool():
    return {str(r["isActive"]): r["n"] for r in db.execute(POOL)}

before = pool()
body = json.dumps({
    "model": f"bai/{model}",
    "messages": [{"role": "user", "content": "say ok"}],
    "max_tokens": 8,
    "stream": False,
}).encode()
req = urllib.request.Request(
    "http://127.0.0.1:20127/v1/chat/completions",
    data=body,
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
)
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=tmo) as r:
        print("HTTP", r.status, f"{time.time()-t0:.1f}s")
        print(r.read(500).decode(errors="replace"))
except urllib.error.HTTPError as e:
    print("HTTP", e.code, f"{time.time()-t0:.1f}s")
    print(e.read(500).decode(errors="replace"))
except Exception as e:
    print("ERR", type(e).__name__, str(e)[:200], f"{time.time()-t0:.1f}s")

print("elapsed", f"{time.time()-t0:.1f}s")
print("pool before:", before)
print("pool after :", pool())
