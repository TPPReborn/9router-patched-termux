// Bun runtime adapter — uses built-in bun:sqlite (native, fastest under Bun).
// Loaded only when process.versions.bun is present.
import { PRAGMA_SQL } from "../schema.js";

const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
const BUSY_TIMEOUT_MS = 30_000;
const BUSY_RETRIES = 6;

function isBusyError(e) {
  return !!e && (e.code === "SQLITE_BUSY" || /database is locked|SQLITE_BUSY/i.test(String(e.message || e)));
}

function withBusyRetry(fn) {
  let last;
  for (let i = 0; i < BUSY_RETRIES; i++) {
    try {
      return fn();
    } catch (e) {
      last = e;
      if (!isBusyError(e) || i === BUSY_RETRIES - 1) throw e;
      const ms = Math.min(1000, 25 * 2 ** i);
      const end = Date.now() + ms;
      while (Date.now() < end) { /* sync backoff */ }
    }
  }
  throw last;
}

export async function createBunSqliteAdapter(filePath) {
  const { Database } = await import("bun:sqlite");
  const db = new Database(filePath, { create: true });
  db.exec(PRAGMA_SQL);
  try { db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`); } catch {}

  const stmtCache = new Map();
  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  const checkpointTimer = setInterval(() => {
    try { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch {}
  }, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }
  const onShutdown = () => gracefulClose();
  process.once("beforeExit", onShutdown);
  process.once("SIGINT", () => { onShutdown(); process.exit(0); });
  process.once("SIGTERM", () => { onShutdown(); process.exit(0); });

  return {
    driver: "bun:sqlite",
    run(sql, params = []) {
      return withBusyRetry(() => {
        const r = prepare(sql).run(...params);
        return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
      });
    },
    get(sql, params = []) {
      return withBusyRetry(() => prepare(sql).get(...params));
    },
    all(sql, params = []) {
      return withBusyRetry(() => prepare(sql).all(...params));
    },
    exec(sql) {
      return withBusyRetry(() => db.exec(sql));
    },
    transaction(fn) {
      return withBusyRetry(() => {
        const tx = db.transaction(fn);
        return tx();
      });
    },
    checkpoint() {
      try { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch {}
    },
    close() {
      clearInterval(checkpointTimer);
      gracefulClose();
    },
    raw: db,
  };
}
