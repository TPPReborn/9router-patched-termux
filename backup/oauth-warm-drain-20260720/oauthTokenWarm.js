// Background OAuth token warmer for providers with large multi-account pools
// (notably grok-cli). Request-path checkAndRefreshToken only refreshes the
// selected account; idle expired accounts stay stale until selected. This
// scheduler proactively refreshes near-expiry / expired tokens so the pool
// stays usable under round-robin.
//
// Fail-open: any error is logged and the next tick continues.
// xAI refresh tokens are single-use — checkAndRefreshToken re-reads DB +
// dedups concurrent refresh; keep concurrency modest to avoid revoke storms.

import { getProviderConnections } from "@/lib/localDb";
import {
  shouldRefreshCredentials,
  checkAndRefreshToken,
} from "@/sse/services/tokenRefresh.js";

// Providers that mint short-lived access tokens + rotate refresh tokens and
// are commonly bulk-imported (device-code / multi-account).
// Live pool is grok-cli only (xai provider rows are separate / usually empty).
// Do not warm "xai" unless accounts exist — keeps logs clean and avoids noise.
const WARM_PROVIDERS = ["grok-cli"];

const DEFAULTS = {
  // First tick after process start (let DB/adapters settle).
  initialDelayMs: 30_000,
  // Steady-state cadence — denser than cron (30m) so AT stays warm.
  intervalMs: 5 * 60 * 1000,
  // Cap concurrent upstream refresh calls (xAI single-use RT — keep low).
  concurrency: 2,
  // Max accounts refreshed per tick (2611 pool → many ticks, not one hammer).
  batchSize: 80,
};

const g = (globalThis.__oauthTokenWarm ??= {
  timer: null,
  running: false,
  started: false,
});

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

async function collectDueConnections() {
  const due = [];
  for (const provider of WARM_PROVIDERS) {
    let connections = [];
    try {
      connections = await getProviderConnections({ provider, isActive: true });
    } catch (err) {
      console.warn(`[OAuthWarm] list ${provider} failed:`, err?.message || err);
      continue;
    }
    for (const c of connections) {
      if (!c?.refreshToken) continue;
      if (!shouldRefreshCredentials(provider, c)) continue;
      due.push({ provider, connection: c });
    }
  }
  // Soonest expiry first so we spend the batch budget on the hottest accounts.
  due.sort((a, b) => {
    const ae = new Date(a.connection.expiresAt || 0).getTime() || 0;
    const be = new Date(b.connection.expiresAt || 0).getTime() || 0;
    return ae - be;
  });
  return due;
}

export async function runOAuthTokenWarmTick(opts = {}) {
  if (g.running) return { skipped: true, reason: "in_flight" };
  g.running = true;
  const cfg = { ...DEFAULTS, ...opts };
  const started = Date.now();
  let refreshed = 0;
  let failed = 0;
  let considered = 0;
  let adopted = 0;

  try {
    const due = await collectDueConnections();
    considered = due.length;
    const batch = due.slice(0, cfg.batchSize);
    if (!batch.length) {
      return { considered, refreshed, failed, adopted, ms: Date.now() - started };
    }

    await mapPool(batch, cfg.concurrency, async ({ provider, connection }) => {
      const credentials = {
        ...connection,
        connectionId: connection.id,
      };
      try {
        const next = await checkAndRefreshToken(provider, credentials);
        if (next?.unrecoverable) {
          failed += 1;
          return;
        }
        if (
          next?.accessToken &&
          (next.accessToken !== connection.accessToken ||
            (next.lastRefreshAt && next.lastRefreshAt !== connection.lastRefreshAt) ||
            (next.expiresAt && next.expiresAt !== connection.expiresAt))
        ) {
          // If RT changed without us driving network (race winner), count as adopted.
          if (
            next.refreshToken &&
            connection.refreshToken &&
            next.refreshToken !== connection.refreshToken &&
            next.lastRefreshAt === connection.lastRefreshAt
          ) {
            adopted += 1;
          } else {
            refreshed += 1;
          }
        }
      } catch (err) {
        failed += 1;
        console.warn(
          `[OAuthWarm] ${provider}/${String(connection.id || "").slice(0, 8)} failed:`,
          err?.message || err
        );
      }
    });

    console.log(
      `[OAuthWarm] tick considered=${considered} batch=${batch.length} refreshed=${refreshed} adopted=${adopted} failed=${failed} ms=${Date.now() - started}`
    );
    return {
      considered,
      batch: batch.length,
      refreshed,
      adopted,
      failed,
      ms: Date.now() - started,
    };
  } finally {
    g.running = false;
  }
}

export function startOAuthTokenWarm(opts = {}) {
  if (g.started) return;
  g.started = true;
  const cfg = { ...DEFAULTS, ...opts };

  const schedule = (delay) => {
    g.timer = setTimeout(async () => {
      try {
        await runOAuthTokenWarmTick(cfg);
      } catch (err) {
        console.warn("[OAuthWarm] tick error:", err?.message || err);
      }
      // Recurring.
      schedule(cfg.intervalMs);
    }, delay);
    g.timer.unref?.();
  };

  schedule(cfg.initialDelayMs);
  console.log(
    `[OAuthWarm] started providers=${WARM_PROVIDERS.join(",")} intervalMs=${cfg.intervalMs} batch=${cfg.batchSize} concurrency=${cfg.concurrency}`
  );
}

export function stopOAuthTokenWarm() {
  if (g.timer) {
    clearTimeout(g.timer);
    g.timer = null;
  }
  g.started = false;
  g.running = false;
}
