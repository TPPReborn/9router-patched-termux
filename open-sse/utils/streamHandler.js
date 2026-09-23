// Stream handler with disconnect detection - shared for all providers
import { STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Client-abort reasons that are expected when a caller hangs up mid-stream
// (e.g. client read timeout, user cancel, upstream slow-start + client retry).
// These are NORMAL lifecycle events, not server failures: keep them out of the
// error stream so a busy gateway doesn't drown the console in aborts.
// Any non-listed reason still logs at error level.
const CLIENT_ABORT_REASONS = new Set([
  "ResponseAborted",
  "client_closed",
  "cancelled",
  "canceled",
  "aborted",
  "abort",
  "client_abort",
]);

export function isClientAbortReason(reason) {
  if (!reason) return false;
  const r = String(reason).toLowerCase();
  if (CLIENT_ABORT_REASONS.has(reason) || CLIENT_ABORT_REASONS.has(r)) return true;
  return r.includes("responseaborted") || r.includes("client") || r.includes("abort") || r.includes("cancel");
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({ onDisconnect, onError, log, provider, model, reqTag = "" } = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  // Only abnormal terminations are logged; normal completion is covered by "📊 done".
  // isError uses errorLine (always shown, ignores LOG_LEVEL) so failures survive quiet levels.
  const logStream = (symbol, status, isError = false) => {
    const duration = Date.now() - startTime;
    const emit = isError ? log?.errorLine : log?.line;
    if (emit) emit(reqTag, symbol, `${status} · ${provider}/${model} · ${duration}ms`);
    else console.log(`[${getTimeString()}] ${symbol} ${provider}/${model} · ${status} · ${duration}ms`);
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;

      // Expected client hangs-up (timeout/cancel/retry) are logged quietly at
      // debug level instead of flooding the error stream. Only real anomalies
      // (unknown reasons) keep the visible ⚡ line.
      const clientAbort = isClientAbortReason(reason);
      if (clientAbort) {
        dbg("CTRL", `${provider}/${model} | client-abort=${reason} | dur=${Date.now() - startTime}ms`);
      } else {
        logStream("⚡", `DISCONNECT: ${reason}`);
        dbg("CTRL", `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`);
      }

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, 500);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally (no line here — "📊 done" is authoritative)
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("⚡", "ABORTED");
        return;
      }

      logStream("✗", `ERROR: ${error.message}${error.stack ? `\n    ${error.stack}` : ""}`, true);
      onError?.(error);
    },

    abort: () => abortController.abort()
  };
}

// Idle keepalive for the client-facing SSE stream. Sent as an SSE comment
// (ignored by spec-compliant parsers) so a long upstream prefill or account
// fallback cannot trip short client/proxy read timeouts on large requests
// (some callers abort a silent stream after ~10s).
const STREAM_KEEPALIVE_INTERVAL_MS = 5000;
const STREAM_KEEPALIVE_BYTES = new TextEncoder().encode(": keepalive\n\n");
// Once the final marker is forwarded we stop waiting for upstream EOF — but
// keep draining in the background (bounded) so transform flush and usage
// accounting still run to completion.
const STREAM_DRAIN_TIMEOUT_MS = 30000;

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 */
export function createDisconnectAwareStream(transformStream, streamController, onAbortTerminal = null) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable.getWriter();
  let terminalEmitted = false;
  let finalMarkerSent = false;
  let draining = false;
  let keepaliveTimer = null;
  let lastOutputAt = Date.now();
  let atLineBoundary = true;

  // Emit a synthesized terminal payload (e.g. Responses response.failed + [DONE]) once
  const emitTerminal = (controller) => {
    if (terminalEmitted || !onAbortTerminal) return;
    terminalEmitted = true;
    try {
      const bytes = onAbortTerminal();
      if (bytes) controller.enqueue(bytes);
    } catch { /* best-effort terminal */ }
  };

  // Detect the final SSE marker so the client response can end promptly.
  // Scans small chunks only (markers are tiny single events; decoding large
  // content chunks would be wasted work) and anchors on start/newline so
  // marker text inside model content can't false-positive.
  const isFinalMarker = (value) => {
    const len = value?.byteLength || value?.length || 0;
    if (!len || len > 1024) return false;
    let text;
    try { text = new TextDecoder().decode(value); } catch { return false; }
    return (
      text.startsWith("data: [DONE]") || text.includes("\ndata: [DONE]") ||
      text.startsWith("event: message_stop") || text.includes("\nevent: message_stop")
    );
  };

  const stopKeepalive = () => {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
  };

  // Track the last byte pushed downstream so keepalives are only injected
  // while the stream is idle AND at a line boundary — never mid-event.
  const noteOutput = (value) => {
    lastOutputAt = Date.now();
    const len = value?.byteLength || value?.length || 0;
    if (!len) return;
    const last = value[len - 1];
    atLineBoundary = last === 0x0a || last === "\n";
  };

  // Background drain after early close: read upstream to EOF (or timeout) so
  // the transform's flush() — usage stats, request detail — still runs.
  const drainUpstream = () => {
    if (draining) return;
    draining = true;
    const timer = setTimeout(() => { reader.cancel().catch(() => { }); }, STREAM_DRAIN_TIMEOUT_MS);
    (async () => {
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) break;
        }
      } catch { /* upstream gone */ } finally { clearTimeout(timer); }
    })();
  };

  return new ReadableStream({
    start(controller) {
      keepaliveTimer = setInterval(() => {
        if (!streamController.isConnected() || finalMarkerSent) { stopKeepalive(); return; }
        if (!atLineBoundary) return; // never inject mid-line
        if (Date.now() - lastOutputAt < STREAM_KEEPALIVE_INTERVAL_MS) return; // data is flowing
        try {
          controller.enqueue(STREAM_KEEPALIVE_BYTES);
          lastOutputAt = Date.now();
        } catch { stopKeepalive(); }
      }, STREAM_KEEPALIVE_INTERVAL_MS);
    },

    async pull(controller) {
      if (!streamController.isConnected()) {
        stopKeepalive();
        emitTerminal(controller);
        controller.close();
        return;
      }

      // Final marker already forwarded to the client: end the response now.
      // Waiting for upstream EOF first is what leaves the socket open just
      // long enough for a client that already saw [DONE] to close before the
      // server does — surfacing as a spurious ResponseAborted.
      if (finalMarkerSent) {
        stopKeepalive();
        streamController.handleComplete();
        controller.close();
        drainUpstream();
        return;
      }

      try {
        const { done, value } = await reader.read();

        if (done) {
          stopKeepalive();
          streamController.handleComplete();
          controller.close();
          return;
        }
        if (isFinalMarker(value)) finalMarkerSent = true;
        noteOutput(value);
        controller.enqueue(value);
      } catch (error) {
        stopKeepalive();
        const wasConnected = streamController.isConnected();
        // Controller already closed = downstream ended; not an upstream error, skip noisy log.
        const msg0 = error?.message || "";
        const isControllerClosed = msg0.includes("already closed") || msg0.includes("Invalid state");
        if (!isControllerClosed) streamController.handleError(error);
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});

        // Treat network resets / socket hang up / abort as graceful close
        const msg = error?.message || "";
        const code = error?.code || error?.cause?.code || "";
        const isNetworkClose =
          error.name === "AbortError" ||
          msg.includes("aborted") ||
          msg.includes("socket hang up") ||
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("EPIPE") ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT" ||
          code === "EPIPE" ||
          code === "UND_ERR_SOCKET";

        // Graceful close on network/abort, or when a structured terminal is available
        // (Responses passthrough prefers response.failed + [DONE] over a raw transport error)
        try {
          if (!wasConnected || isNetworkClose || onAbortTerminal) {
            emitTerminal(controller);
            controller.close();
          } else {
            controller.error(error);
          }
        } catch (e) { /* already closed or cancelled */ }
      }
    },

    cancel(reason) {
      stopKeepalive();
      // Cancellation after the final marker is just the client (or Next.js)
      // tearing down an already-finished response — treat it as normal
      // completion, not a disconnect. Only pre-marker cancels are aborts.
      if (finalMarkerSent) streamController.handleComplete();
      else streamController.handleDisconnect(reason || "cancelled");
      reader.cancel();
      writer.abort();
    }
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal = null, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS) {
  let stallTimer = null;
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  const t0 = Date.now();
  const tag = "STREAM";
  const clearStall = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  };
  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      dbg(tag, `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`);
      streamController.handleError?.(new Error("stream stall timeout"));
      streamController.abort?.();
    }, stallTimeoutMs);
  };

  // Wrap controller so every termination path clears the stall timer.
  // Without this, abort/cancel/downstream-error paths leave the timer armed
  // and a stale abort could fire after the request has already ended.
  const wrappedController = {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    handleComplete: () => { dbg(tag, `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleComplete(); },
    handleError: (e) => { dbg(tag, `error: ${e?.message} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleError(e); },
    handleDisconnect: (r) => { dbg(tag, `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleDisconnect(r); },
    abort: () => { clearStall(); streamController.abort(); }
  };

  armStall();
  dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms`);

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;
      if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
        dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`);
      }
      armStall();
      controller.enqueue(chunk);
    },
    flush() { dbg(tag, `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); }
  });

  const transformedBody = providerResponse.body
    .pipeThrough(upstreamTap)
    .pipeThrough(transformStream);

  return createDisconnectAwareStream(
    { readable: transformedBody, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
    wrappedController,
    onAbortTerminal
  );
}

