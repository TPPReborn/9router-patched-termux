"""Backfill: disable accounts whose stored lastError matches the new
ACCOUNT_EXHAUSTED_RE (403/402/insufficient-credit class). Mirrors exactly what
markAccountUnavailable / getProviderCredentials now do at runtime.
Safe + idempotent: only touches isActive=1 rows whose lastError matches.
"""
import sqlite3, json, re, datetime, sys

DB = "/home/agentuser/.9router/db/data.sqlite"
RE = re.compile(
    r"free-usage-exhausted|used all the included free usage|out of credits|no.?credits?\b"
    r"|credit.?insufficient|insufficient.?credit|insufficient.?balance|out of balance"
    r"|exceeded your current quota|need a grok subscription|payment required"
    r"|insufficient.?quota|spending.?limit|subscription:free-usage-exhausted|billing_error",
    re.I,
)

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row
now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

hits = []
for r in db.execute("SELECT id, provider, name, isActive, data FROM providerConnections"):
    d = json.loads(r["data"] or "{}")
    err = str(d.get("lastError") or "")
    if RE.search(err):
        hits.append((r["id"], r["provider"], r["name"], r["isActive"], d))

print(f"matched {len(hits)} rows")
for cid, prov, name, active, d in hits[:5]:
    print(f"  {cid[:8]} {name} isActive={active} :: {str(d.get('lastError'))[:80]}")

if "--apply" not in sys.argv:
    print("dry-run (pass --apply to write)")
    sys.exit(0)

changed = 0
for cid, prov, name, active, d in hits:
    if active == 0:
        continue
    d["isActive"] = False
    d["testStatus"] = "error"
    d["errorCode"] = d.get("errorCode") if d.get("errorCode") is not None else 402
    d["lastErrorAt"] = d.get("lastErrorAt") or now
    db.execute(
        "UPDATE providerConnections SET isActive=0, data=?, updatedAt=? WHERE id=?",
        (json.dumps(d), now, cid),
    )
    changed += 1
db.commit()
print(f"disabled {changed} accounts")
tot = db.execute("SELECT COUNT(*) FROM providerConnections WHERE isActive=0").fetchone()[0]
print(f"total inactive now: {tot}")
