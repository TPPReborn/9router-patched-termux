// Cross-process refresh gate for single-use OAuth refresh tokens (xAI / grok-cli).
// Lives in open-sse (no src/ imports) so Next/webpack can bundle it.
//
// mkdir-as-lock under DATA_DIR so Node + external cron share one mutex per connection.
// Nested re-entry (same async chain) via AsyncLocalStorage.
// Fail-open on unexpected FS errors.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";

const STALE_MS = 120_000;
const DEFAULT_WAIT_MS = 90_000;
const POLL_MS = 40;

/** @type {AsyncLocalStorage<Set<string>>} */
const heldAls = new AsyncLocalStorage();

function resolveDataDir() {
  const configured = process.env.DATA_DIR;
  if (configured) return configured;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  }
  return path.join(os.homedir(), ".9router");
}

function lockRoot() {
  return path.join(resolveDataDir(), "locks", "oauth-refresh");
}

export function refreshLockPath(connectionId) {
  const id = String(connectionId || "unknown");
  const hash = crypto.createHash("sha1").update(id).digest("hex").slice(0, 16);
  return path.join(lockRoot(), `${hash}.lock`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tryStealStale(lockPath) {
  try {
    const st = fs.statSync(lockPath);
    if (Date.now() - st.mtimeMs > STALE_MS) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      return true;
    }
  } catch {
    /* gone */
  }
  return false;
}

/**
 * Exclusive cross-process critical section for one connection's token rotation.
 * @returns {Promise<{ acquired: boolean, result?: any, reason?: string }>}
 */
export async function withRefreshGate(connectionId, fn, opts = {}) {
  if (!connectionId) {
    return { acquired: true, result: await fn() };
  }

  const parentHeld = heldAls.getStore();
  if (parentHeld?.has(connectionId)) {
    return { acquired: true, result: await fn(), reason: "reentrant" };
  }

  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const lockPath = refreshLockPath(connectionId);
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    return { acquired: true, result: await fn(), reason: "fs_error_fail_open" };
  }

  const started = Date.now();
  let acquired = false;

  while (!acquired) {
    try {
      fs.mkdirSync(lockPath);
      acquired = true;
      try {
        fs.writeFileSync(
          path.join(lockPath, "owner"),
          JSON.stringify({ pid: process.pid, connectionId, at: new Date().toISOString() }),
        );
      } catch {
        /* ignore */
      }
    } catch (e) {
      if (e?.code !== "EEXIST") {
        return { acquired: true, result: await fn(), reason: "fs_error_fail_open" };
      }
      tryStealStale(lockPath);
      if (Date.now() - started >= waitMs) {
        return { acquired: false, reason: "lock_timeout" };
      }
      await sleep(POLL_MS);
    }
  }

  const held = new Set(parentHeld);
  held.add(connectionId);

  try {
    const result = await heldAls.run(held, fn);
    return { acquired: true, result };
  } finally {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function isSingleUseRefreshProvider(provider) {
  return provider === "grok-cli" || provider === "gcli" || provider === "xai";
}
