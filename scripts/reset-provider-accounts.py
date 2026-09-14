"""Reset error state + enable every account of one provider node.

Clears data JSON fields: lastError, lastErrorAt, errorCode, backoffLevel,
testStatus -> "active", isActive -> 1 (column), and all modelLock_* keys.

Usage:
  python3 scripts/reset-provider-accounts.py <provider-substring>           # dry-run
  python3 scripts/reset-provider-accounts.py <provider-substring> --apply
"""
import sqlite3, json, sys, datetime, shutil, os

DB = "/home/agentuser/.9router/db/data.sqlite"
STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")

pat = sys.argv[1] if len(sys.argv) > 1 else None
if not pat:
    print(__doc__)
    sys.exit(2)
apply_write = "--apply" in sys.argv

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

rows = list(db.execute(
    "SELECT id, name, isActive, data FROM providerConnections WHERE provider LIKE ?", (f"%{pat}%",)
))
if not rows:
    print("no rows matched", pat)
    sys.exit(1)

error_keys = ("lastError", "lastErrorAt", "errorCode", "backoffLevel")
touched_err = touched_lock = 0
for r in rows:
    d = json.loads(r["data"] or "{}")
    if any(d.get(k) is not None for k in error_keys):
        touched_err += 1
    if any(k.startswith("modelLock_") for k in d):
        touched_lock += 1

inactive = sum(1 for r in rows if r["isActive"] == 0)
print(f"provider match: {len(rows)} rows | with error state: {touched_err} | with model locks: {touched_lock} | isActive=0: {inactive}")

if not apply_write:
    print("dry-run — pass --apply to write (stop the server first)")
    sys.exit(0)

backup = os.path.join(os.path.dirname(DB), "backups", f"data.sqlite.pre-reset-{STAMP}")
shutil.copy2(DB, backup)
print("backup:", backup)

now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
changed = 0
for r in rows:
    d = json.loads(r["data"] or "{}")
    for k in error_keys:
        d.pop(k, None)
    for k in [k for k in d if k.startswith("modelLock_")]:
        d.pop(k, None)
    d["testStatus"] = "active"
    db.execute(
        "UPDATE providerConnections SET isActive=1, data=?, updatedAt=? WHERE id=?",
        (json.dumps(d), now, r["id"]),
    )
    changed += 1
db.commit()

left = db.execute(
    "SELECT COUNT(*) FROM providerConnections WHERE provider LIKE ? AND isActive=0", (f"%{pat}%",)
).fetchone()[0]
print(f"reset {changed} accounts | still inactive: {left}")
