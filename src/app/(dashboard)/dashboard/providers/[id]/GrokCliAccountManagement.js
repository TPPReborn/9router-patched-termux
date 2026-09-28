"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/shared/components";

const LIVE_CONCURRENCY = 12;

function accountName(conn) {
  return (
    conn?.displayName ||
    conn?.name ||
    conn?.email ||
    (conn?.id ? String(conn.id).slice(0, 8) : "—")
  );
}

function isHealthyConnection(conn, live) {
  // Disabled accounts always count as BAD (even if a prior live check was green)
  if (conn?.isActive === false) return false;
  // Live result wins when present
  if (live?.state === "success") return true;
  if (live?.state === "failed") return false;
  if (conn?.testStatus === "error" || conn?.testStatus === "unavailable") return false;
  if (conn?.lastError || conn?.errorCode) return false;
  return true;
}

/** True when list API / JWT decode marked bot_flag_source on this connection. */
function isBotFlagged(conn) {
  if (!conn) return false;
  if (conn.botFlag === true) return true;
  const src =
    conn.botFlagSource ??
    conn?.providerSpecificData?.botFlagSource ??
    conn?.providerSpecificData?.bot_flag_source;
  return (
    src === 1 ||
    src === "1" ||
    src === true ||
    (typeof src === "number" && src > 0) ||
    (typeof src === "string" && src !== "" && src !== "0" && src !== "false")
  );
}

function formatAgo(iso) {
  if (!iso) return "belum pernah";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const delta = Math.floor((Date.now() - t) / 1000);
  if (delta < 0) return "baru saja";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) {
    const m = Math.floor(delta / 60);
    const s = delta % 60;
    return `${m}m ${s}s ago`;
  }
  if (delta < 86400) {
    const h = Math.floor(delta / 3600);
    const m = Math.floor((delta % 3600) / 60);
    return `${h}h ${m}m ago`;
  }
  const d = Math.floor(delta / 86400);
  const h = Math.floor((delta % 86400) / 3600);
  return `${d}d ${h}h ago`;
}

function formatWib(iso) {
  if (!iso) return "—";
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "—";
  try {
    return t.toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + " WIB";
  } catch {
    return t.toISOString();
  }
}

async function mapPool(items, concurrency, worker) {
  if (!items.length) return;
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx;
      idx += 1;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

/**
 * GROK CLI Account Management panel — legend + collapsible live-check table.
 * Default table hidden; Unhide triggers parallel /api/providers/{id}/test.
 */
export default function GrokCliAccountManagement({ connections = [], onRefreshConnections }) {
  const [tableOpen, setTableOpen] = useState(false);
  const [liveRunning, setLiveRunning] = useState(false);
  const [liveStopping, setLiveStopping] = useState(false);
  const [liveResults, setLiveResults] = useState({}); // id -> { state, status, message, refreshed, testedAt }
  const [progress, setProgress] = useState({ total: 0, done: 0 });
  const stopRef = useRef(false);

  const legend = useMemo(() => {
    let healthy = 0;
    let bad = 0;
    let botFlag = 0;
    for (const c of connections) {
      if (isHealthyConnection(c, liveResults[c.id])) healthy += 1;
      else bad += 1;
      if (isBotFlagged(c)) botFlag += 1;
    }
    return { healthy, bad, botFlag, total: connections.length };
  }, [connections, liveResults]);

  const rows = useMemo(() => {
    // Stable order: unhealthy first, then name
    return [...connections].sort((a, b) => {
      const ah = isHealthyConnection(a, liveResults[a.id]) ? 1 : 0;
      const bh = isHealthyConnection(b, liveResults[b.id]) ? 1 : 0;
      if (ah !== bh) return ah - bh;
      return accountName(a).localeCompare(accountName(b));
    });
  }, [connections, liveResults]);

  const runLiveCheck = useCallback(async () => {
    if (liveRunning || connections.length === 0) return;
    stopRef.current = false;
    setLiveRunning(true);
    setLiveStopping(false);
    setProgress({ total: connections.length, done: 0 });
    setLiveResults(
      Object.fromEntries(
        connections.map((c) => [c.id, { state: "queued", status: null, message: null, refreshed: false }]),
      ),
    );

    let done = 0;
    await mapPool(connections, LIVE_CONCURRENCY, async (connection) => {
      if (stopRef.current) {
        setLiveResults((prev) => ({
          ...prev,
          [connection.id]: {
            ...(prev[connection.id] || {}),
            state: prev[connection.id]?.state === "queued" ? "skipped" : prev[connection.id]?.state,
          },
        }));
        return;
      }

      setLiveResults((prev) => ({
        ...prev,
        [connection.id]: { state: "testing", status: null, message: "Testing…", refreshed: false },
      }));

      try {
        const res = await fetch(`/api/providers/${connection.id}/test`, { method: "POST" });
        let data = {};
        try {
          data = await res.json();
        } catch {
          data = {};
        }
        const valid = !!data.valid;
        const message = data.error || data.warning || (valid ? "OK" : "Failed");
        setLiveResults((prev) => ({
          ...prev,
          [connection.id]: {
            state: valid ? "success" : "failed",
            status: res.status,
            message,
            refreshed: !!data.refreshed,
            testedAt: new Date().toISOString(),
          },
        }));
      } catch (err) {
        setLiveResults((prev) => ({
          ...prev,
          [connection.id]: {
            state: "failed",
            status: null,
            message: err?.message || "Network error",
            refreshed: false,
            testedAt: new Date().toISOString(),
          },
        }));
      } finally {
        done += 1;
        setProgress({ total: connections.length, done });
      }
    });

    setLiveRunning(false);
    setLiveStopping(false);
    stopRef.current = false;
    // Pull fresh lastRefreshAt / testStatus from API after bulk test
    if (typeof onRefreshConnections === "function") {
      try {
        await onRefreshConnections();
      } catch {
        /* ignore */
      }
    }
  }, [connections, liveRunning, onRefreshConnections]);

  const handleToggleTable = async () => {
    if (tableOpen) {
      // hide
      if (liveRunning) {
        stopRef.current = true;
        setLiveStopping(true);
      }
      setTableOpen(false);
      return;
    }
    setTableOpen(true);
    // Unhide → start parallel live check
    await runLiveCheck();
  };

  const handleStop = () => {
    if (!liveRunning) return;
    stopRef.current = true;
    setLiveStopping(true);
  };

  const handleRerun = async () => {
    if (liveRunning) return;
    await runLiveCheck();
  };

  if (!connections.length) return null;

  return (
    <div className="mt-4 rounded-xl border border-black/10 bg-gradient-to-b from-sky-500/[0.04] to-transparent p-4 dark:border-white/10 dark:from-sky-400/[0.06]">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold tracking-wide text-text">
            GROK CLI Account Management
          </h3>
          <p className="text-xs text-text-muted">
            Live health overview · parallel token/connection probe
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tableOpen && liveRunning && (
            <Button size="sm" variant="ghost" icon="stop" onClick={handleStop} disabled={liveStopping}>
              {liveStopping ? "Stopping…" : "Stop"}
            </Button>
          )}
          {tableOpen && !liveRunning && (
            <Button size="sm" variant="secondary" icon="refresh" onClick={handleRerun}>
              Re-run Live Check
            </Button>
          )}
          <Button
            size="sm"
            variant={tableOpen ? "secondary" : "primary"}
            icon={tableOpen ? "visibility_off" : "visibility"}
            onClick={handleToggleTable}
            disabled={liveRunning && !tableOpen}
          >
            {tableOpen ? "Hide Table" : liveRunning ? "Checking…" : "Unhide Table"}
          </Button>
        </div>
      </div>

      {/* Legend: Healthy | Bad | Bot Flag | Total */}
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
              Healthy
            </span>
            <span className="text-lg font-bold text-emerald-700 dark:text-emerald-300">
              {legend.healthy}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-emerald-800/80 dark:text-emerald-200/70">
            Akun Valid (No error dan aktif).
          </p>
        </div>
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-400">
              Bad
            </span>
            <span className="text-lg font-bold text-rose-700 dark:text-rose-300">{legend.bad}</span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-rose-800/80 dark:text-rose-200/70">
            Akun Bad (disabled, errorCode, lastError, live fail).
          </p>
        </div>
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
              <span className="material-symbols-outlined text-[14px]">smart_toy</span>
              Bot Flag
            </span>
            <span className="text-lg font-bold text-amber-700 dark:text-amber-300">
              {legend.botFlag}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-amber-800/80 dark:text-amber-200/70">
            JWT accessToken punya claim bot_flag_source (decode realtime).
          </p>
        </div>
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-400">
              Total
            </span>
            <span className="text-lg font-bold text-sky-700 dark:text-sky-300">{legend.total}</span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-sky-800/80 dark:text-sky-200/70">
            Total keseluruhan akun.
          </p>
        </div>
      </div>

      {/* Collapsible live table overlay */}
      {tableOpen && (
        <div className="relative overflow-hidden rounded-lg border border-black/10 bg-background/95 shadow-sm dark:border-white/10">
          {(liveRunning || progress.done > 0) && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/5 px-3 py-2 text-xs text-text-muted dark:border-white/5">
              <span>
                Live check: {progress.done}/{progress.total}
                {liveRunning ? " · running parallel…" : " · done"}
              </span>
              {liveRunning && (
                <div className="h-1.5 w-40 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                  <div
                    className="h-full rounded-full bg-sky-500 transition-all"
                    style={{
                      width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                    }}
                  />
                </div>
              )}
            </div>
          )}

          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-xs">
              <thead className="sticky top-0 z-10 bg-black/[0.04] backdrop-blur dark:bg-white/[0.06]">
                <tr className="border-b border-black/10 text-[11px] uppercase tracking-wide text-text-muted dark:border-white/10">
                  <th className="px-3 py-2 font-semibold">No</th>
                  <th className="px-3 py-2 font-semibold">Name</th>
                  <th className="px-3 py-2 font-semibold">Healthy</th>
                  <th className="px-3 py-2 font-semibold">Bot Flag</th>
                  <th className="px-3 py-2 font-semibold">Response Live Check</th>
                  <th className="px-3 py-2 font-semibold">Last Refresh Token</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((conn, index) => {
                  const live = liveResults[conn.id];
                  const healthy = isHealthyConnection(conn, live);
                  const bot = isBotFlagged(conn);
                  const liveMsg = (() => {
                    if (!live || live.state === "queued") return "Queued";
                    if (live.state === "testing") return "Testing…";
                    if (live.state === "skipped") return "Skipped";
                    const code = live.status != null ? String(live.status) : "—";
                    const msg = live.message || "";
                    const refreshTag = live.refreshed ? " · refreshed" : "";
                    return `${code}${msg ? ` · ${msg}` : ""}${refreshTag}`;
                  })();

                  // Prefer live-updated refresh time if connection was re-fetched;
                  // otherwise show stored lastRefreshAt.
                  const lastRefresh = conn.lastRefreshAt;

                  return (
                    <tr
                      key={conn.id}
                      className="border-b border-black/[0.04] odd:bg-black/[0.015] dark:border-white/[0.04] dark:odd:bg-white/[0.02]"
                    >
                      <td className="px-3 py-1.5 tabular-nums text-text-muted">{index + 1}</td>
                      <td className="max-w-[220px] truncate px-3 py-1.5 font-medium text-text" title={accountName(conn)}>
                        {accountName(conn)}
                        {conn.isActive === false && (
                          <span className="ml-1 text-[10px] text-rose-500">(inactive)</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <span
                          className={
                            healthy
                              ? "inline-flex rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300"
                              : "inline-flex rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:text-rose-300"
                          }
                        >
                          {healthy ? "yes" : "no"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        {bot ? (
                          <span
                            className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:text-amber-200"
                            title={`bot_flag_source=${conn.botFlagSource ?? "present"}`}
                          >
                            <span className="material-symbols-outlined text-[12px]">smart_toy</span>
                            yes
                            {conn.botFlagSource != null && conn.botFlagSource !== true
                              ? ` (${conn.botFlagSource})`
                              : ""}
                          </span>
                        ) : (
                          <span className="text-[11px] text-text-muted">—</span>
                        )}
                      </td>
                      <td className="max-w-[320px] px-3 py-1.5 text-text-muted" title={liveMsg}>
                        <span
                          className={
                            live?.state === "success"
                              ? "text-emerald-600 dark:text-emerald-400"
                              : live?.state === "failed"
                                ? "text-rose-600 dark:text-rose-400"
                                : live?.state === "testing"
                                  ? "text-sky-600 dark:text-sky-400"
                                  : ""
                          }
                        >
                          {liveMsg}
                        </span>
                        {!live && conn.lastError && (
                          <span className="mt-0.5 block truncate text-[10px] text-rose-500" title={conn.lastError}>
                            lastError: {conn.lastError}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-text-muted">
                        <div className="font-medium text-text">{formatAgo(lastRefresh)}</div>
                        <div className="text-[10px] opacity-70">{formatWib(lastRefresh)}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!tableOpen && (
        <p className="text-[11px] text-text-muted">
          Table hidden. Klik <span className="font-medium text-text">Unhide Table</span> untuk live
          check paralel ke <code className="text-[10px]">/api/providers/[id]/test</code>.
        </p>
      )}
    </div>
  );
}
