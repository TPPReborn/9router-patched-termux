// Background OAuth token warmer for multi-account pools (grok-cli).
// Request-path checkAndRefreshToken only covers the selected account.
// This scheduler drains near-expiry / expired tokens, soonest-first.
//
// Fail-open. xAI RT is single-use — go through checkAndRefreshToken (gate+CAS).

import { getProviderConnections } from "@/lib/localDb";
import {
  shouldRefreshCredentials,
  checkAndRefreshToken,
} from "@/sse/services/tokenRefresh.js";
import { QODER_OPENAPI_BASE } from "open-sse/shared/qoder/constants.js";

const WARM_PROVIDERS = ["grok-cli", "qoder"];

// Qoder job token constants (jt-/jrt- based)
const QODER_REFRESH_URL = `${QODER_OPENAPI_BASE}/api/v1/jobToken/refresh`;
const QODER_EXPIRY_WINDOW_MS = 30 * 60 * 1000; // refresh accounts due within 30min

const DEFAULTS = {
  initialDelayMs: 15_000,
  // Steady cadence when queue empty.
  intervalMs: 3 * 60 * 1000,
  // When backlog remains after a tick, reschedule sooner.
  catchUpDelayMs: 20_000,
  // Parallel HTTP refreshes (single-use RT — keep modest).
  concurrency: 3,
  // Soft batch for logging/progress; drain continues until caps below.
  batchSize: 50,
  // Hard cap per tick so one tick can't run forever on 2k+ pool.
  maxPerTick: 400,
  // Wall-clock budget per tick.
  timeBudgetMs: 4 * 60 * 1000,
  // Log a heartbeat even when nothing is due (proves scheduler is alive).
  idleLog: true,
};

const g = (globalThis.__oauthTokenWarm ??= {
  timer: null,
  running: false,
  started: false,
  cfg: null,
  ticks: 0,
});

function remainingMs(connection, now = Date.now()) {
  const raw = connection?.expiresAt || connection?.tokenExpiresAt;
  if (raw) {
    const t = new Date(raw).getTime();
    if (Number.isFinite(t)) return t - now;
  }
  // JWT exp fallback (unsigned decode) — same idea as oauthCredentialManager.
  const at = connection?.accessToken;
  if (at && typeof at === "string") {
    const parts = at.split(".");
    if (parts.length >= 2) {
      try {
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const pad = (4 - (b64.length % 4)) % 4;
        const payload = JSON.parse(Buffer.from(b64 + "=".repeat(pad), "base64").toString("utf8"));
        if (typeof payload.exp === "number") return payload.exp * 1000 - now;
      } catch {
        /* ignore */
      }
    }
  }
  // Unknown expiry but due (shouldRefresh said yes) → treat as urgent.
  return -1;
}

function fmtRem(ms) {
  if (!Number.isFinite(ms)) return "?";
  const sec = Math.round(ms / 1000);
  if (sec < 0) return `${sec}s`;
  if (sec < 120) return `${sec}s`;
  if (sec < 7200) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

function shortId(id) {
  return String(id || "").slice(0, 8);
}

function accountLabel(connection) {
  return connection?.email || connection?.name || shortId(connection?.id);
}

async function mapPool(items, concurrency, worker) {
  if (!items.length) return;
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        await worker(items[i], i);
      } catch {
        /* fail-open per item */
      }
    }
  });
  await Promise.all(runners);
}

// Custom check for qoder job tokens: jt- must exist + valid jrt- + due within window
function shouldRefreshQoderToken(connection) {
  const at = String(connection.accessToken || "");
  const rt = String(connection.refreshToken || "");
  if (!at.startsWith("jt-")) return false;
  if (!rt.startsWith("jrt-")) return false;

  const remaining = remainingMs(connection, Date.now());
  if (remaining === null || remaining === undefined) return false;

  // Due if remaining <= 30min window
  return remaining <= QODER_EXPIRY_WINDOW_MS;
}

async function collectDueConnections() {
  const due = [];
  const now = Date.now();
  let scanned = 0;
  let active = 0;
  for (const provider of WARM_PROVIDERS) {
    let connections = [];
    try {
      connections = await getProviderConnections({ provider, isActive: true });
    } catch (err) {
      console.warn(`[OAuthWarm] list ${provider} failed:`, err?.message || err);
      continue;
    }
    active += connections.length;
    for (const c of connections) {
      scanned += 1;

      // Provider-specific logic
      if (provider === "qoder") {
        if (!shouldRefreshQoderToken(c)) continue;
      } else {
        // grok-cli and others: use existing checkAndRefreshToken
        if (!shouldRefreshCredentials(provider, c)) continue;
      }

      due.push({
        provider,
        connection: c,
        remaining: remainingMs(c, now),
      });
    }
  }
  // Soonest first: most expired (most negative remaining) → least remaining.
  due.sort((a, b) => a.remaining - b.remaining);
  return { due, scanned, active };
}

export async function runOAuthTokenWarmTick(opts = {}) {
  if (g.running) return { skipped: true, reason: "in_flight" };
  g.running = true;
  const cfg = { ...DEFAULTS, ...opts };
  const started = Date.now();
  let refreshed = 0;
  let failed = 0;
  let adopted = 0;
  let unchanged = 0;
  let processed = 0;
  let considered = 0;
  let scanned = 0;
  let active = 0;

  try {
    // One snapshot sorted by urgency; drain in chunks until caps.
    const snap = await collectDueConnections();
    const due = snap.due;
    scanned = snap.scanned;
    active = snap.active;
    considered = due.length;
    g.ticks += 1;

    if (!due.length) {
      if (cfg.idleLog) {
        console.log(
          `[OAuthWarm] tick#${g.ticks} idle active=${active} scanned=${scanned} due=0 ms=${Date.now() - started}`,
        );
      }
      return {
        considered: 0,
        processed: 0,
        refreshed: 0,
        failed: 0,
        adopted: 0,
        unchanged: 0,
        remaining: 0,
        scanned,
        active,
        ms: Date.now() - started,
      };
    }

    console.log(
      `[OAuthWarm] tick#${g.ticks} start due=${considered} active=${active} concurrency=${cfg.concurrency} (soonest rem=${fmtRem(due[0].remaining)})`,
    );

    let offset = 0;
    while (offset < due.length && processed < cfg.maxPerTick) {
      if (Date.now() - started >= cfg.timeBudgetMs) break;

      const room = Math.min(cfg.batchSize, cfg.maxPerTick - processed, due.length - offset);
      const batch = due.slice(offset, offset + room);
      offset += batch.length;

      await mapPool(batch, cfg.concurrency, async ({ provider, connection, remaining }) => {
        const credentials = { ...connection, connectionId: connection.id };
        const label = accountLabel(connection);
        const id8 = shortId(connection.id);
        const beforeExp = connection.expiresAt || null;
        try {
          let next;

          // Provider-specific refresh logic
          if (provider === "qoder") {
            // Qoder job token refresh via POST /api/v1/jobToken/refresh
            const resp = await fetch(QODER_REFRESH_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "User-Agent": "qoder/1.1.14",
              },
              body: JSON.stringify({ refresh_token: connection.refreshToken }),
              signal: AbortSignal.timeout(20_000),
            });

            if (!resp.ok) {
              processed += 1;
              failed += 1;
              console.warn(
                `[OAuthWarm] FAIL ${provider}/${id8} ${label} HTTP ${resp.status} rem=${fmtRem(remaining)} beforeExp=${beforeExp}`,
              );
              return;
            }

            const body = await resp.json();
            if (!body.token) {
              processed += 1;
              failed += 1;
              console.warn(`[OAuthWarm] FAIL ${provider}/${id8} ${label} no token rem=${fmtRem(remaining)}`);
              return;
            }

            const expiresAt = body.expires_at
              ? new Date(body.expires_at).toISOString()
              : new Date(Date.now() + 23 * 3600 * 1000).toISOString();
            const expiresIn = Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000);

            await checkAndRefreshToken(provider, {
              ...credentials,
              accessToken: body.token,
              refreshToken: body.refresh_token || connection.refreshToken,
              expiresAt,
              expiresIn,
              testStatus: "active",
              lastError: null,
              lastErrorAt: null,
              errorCode: null,
            });

            processed += 1;
            tokenChanged = true;
            next = {
              accessToken: body.token,
              refreshToken: body.refresh_token || connection.refreshToken,
              expiresAt,
            };
          } else {
            // grok-cli and others: use existing checkAndRefreshToken
            next = await checkAndRefreshToken(provider, credentials);
          }

          processed += 1;
          if (next?.unrecoverable) {
            failed += 1;
            console.warn(
              `[OAuthWarm] FAIL ${provider}/${id8} ${label} unrecoverable rem=${fmtRem(remaining)} beforeExp=${beforeExp}`,
            );
            return;
          }
          const afterExp = next?.expiresAt || null;
          const tokenChanged =
            next?.accessToken &&
            (next.accessToken !== connection.accessToken ||
              (next.lastRefreshAt && next.lastRefreshAt !== connection.lastRefreshAt) ||
              (afterExp && afterExp !== beforeExp));

          if (tokenChanged) {
            const peerAdopted =
              next.refreshToken &&
              connection.refreshToken &&
              next.refreshToken !== connection.refreshToken &&
              next.lastRefreshAt === connection.lastRefreshAt;
            if (peerAdopted) {
              adopted += 1;
              console.log(
                `[OAuthWarm] ADOPT ${provider}/${id8} ${label} remWas=${fmtRem(remaining)} afterExp=${afterExp}`,
              );
            } else {
              refreshed += 1;
              console.log(
                `[OAuthWarm] REFRESH ${provider}/${id8} ${label} remWas=${fmtRem(remaining)} beforeExp=${beforeExp} afterExp=${afterExp}`,
              );
            }
          } else {
            unchanged += 1;
            console.log(
              `[OAuthWarm] SKIP ${provider}/${id8} ${label} remWas=${fmtRem(remaining)} exp=${afterExp || beforeExp} (already fresh / no change)`,
            );
          }
        } catch (err) {
          processed += 1;
          failed += 1;
          console.warn(
            `[OAuthWarm] FAIL ${provider}/${id8} ${label}:`,
            err?.message || err,
          );
        }
      });
    }

    const remaining = Math.max(0, considered - offset);
    console.log(
      `[OAuthWarm] tick#${g.ticks} done considered=${considered} processed=${processed} refreshed=${refreshed} adopted=${adopted} unchanged=${unchanged} failed=${failed} remaining=${remaining} ms=${Date.now() - started}`,
    );
    return {
      considered,
      processed,
      refreshed,
      adopted,
      unchanged,
      failed,
      remaining,
      scanned,
      active,
      ms: Date.now() - started,
    };
  } finally {
    g.running = false;
  }
}

function scheduleNext(delay) {
  if (g.timer) clearTimeout(g.timer);
  g.timer = setTimeout(async () => {
    const cfg = g.cfg || DEFAULTS;
    let result = null;
    try {
      result = await runOAuthTokenWarmTick(cfg);
    } catch (err) {
      console.warn("[OAuthWarm] tick error:", err?.message || err);
    }
    // Catch-up: backlog left → tighter loop; else steady interval.
    const next =
      result?.remaining > 0
        ? cfg.catchUpDelayMs
        : cfg.intervalMs;
    scheduleNext(next);
  }, delay);
  g.timer.unref?.();
}

export function startOAuthTokenWarm(opts = {}) {
  if (g.started) {
    console.log("[OAuthWarm] already started — skip re-init");
    return;
  }
  g.started = true;
  g.cfg = { ...DEFAULTS, ...opts };
  scheduleNext(g.cfg.initialDelayMs);
  console.log(
    `[OAuthWarm] started providers=${WARM_PROVIDERS.join(",")} initialDelayMs=${g.cfg.initialDelayMs} intervalMs=${g.cfg.intervalMs} catchUpMs=${g.cfg.catchUpDelayMs} maxPerTick=${g.cfg.maxPerTick} concurrency=${g.cfg.concurrency}`,
  );
}

export function stopOAuthTokenWarm() {
  if (g.timer) {
    clearTimeout(g.timer);
    g.timer = null;
  }
  g.started = false;
  g.running = false;
  console.log("[OAuthWarm] stopped");
}
