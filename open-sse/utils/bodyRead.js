import { STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";

/**
 * Thrown when an upstream body read exceeds its budget. Mapped to 504 by the
 * chat handlers so the combo fallback (and the account loop) treat it like any
 * other retryable upstream failure instead of hanging the request forever.
 */
export class BodyReadTimeoutError extends Error {
  constructor(message, phase) {
    super(message);
    this.name = "BodyReadTimeoutError";
    this.phase = phase; // "first-chunk" | "stall"
  }
}

/**
 * Read a whole upstream body with a watchdog instead of `response.text()`.
 *
 * `response.text()` has NO timeout: after the upstream returns response
 * headers (which the connect timer already cleared), a connection that dies
 * or goes silent mid-body hangs the request indefinitely. That is the
 * "connection stops mid-session" failure mode for non-streaming clients and
 * for forceStream providers that are aggregated into JSON.
 *
 * Semantics mirror pipeWithDisconnect: a generous first-chunk budget for
 * prompt prefill, then a per-chunk stall budget once bytes are flowing.
 *
 * @param {Response} response
 * @param {object} [opts]
 * @param {number} [opts.firstTimeoutMs] - budget for the first byte
 * @param {number} [opts.stallTimeoutMs] - budget between chunks once flowing
 * @param {string} [opts.label] - appears in the timeout message
 * @returns {Promise<string>} full body text
 */
export async function readBodyWithStall(response, {
  firstTimeoutMs = STREAM_FIRST_CHUNK_TIMEOUT_MS,
  stallTimeoutMs = STREAM_STALL_TIMEOUT_MS,
  label = "upstream body",
} = {}) {
  const body = response?.body;
  if (!body || typeof body.getReader !== "function") {
    // No streaming surface (synthetic Response) — still bound the read.
    let timer = null;
    try {
      return await Promise.race([
        response.text(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new BodyReadTimeoutError(`${label} read timed out after ${firstTimeoutMs}ms (first-chunk)`, "first-chunk")),
            firstTimeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timer = null;
  let phase = "first-chunk";

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = (ms, phaseName) => {
    cleanup();
    phase = phaseName;
    timer = setTimeout(() => {
      timer = null;
      // Cancel so the upstream fetch/socket is torn down, not leaked.
      reader.cancel().catch(() => {});
      rejectTimeout(new BodyReadTimeoutError(
        `${label} read timed out after ${ms}ms (${phaseName})`,
        phaseName
      ));
    }, ms);
  };

  let rejectTimeout = () => {};

  try {
    return await new Promise((resolve, reject) => {
      rejectTimeout = reject;
      arm(firstTimeoutMs, "first-chunk");
      (async () => {
        for (;;) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch (err) {
            cleanup();
            reject(err);
            return;
          }
          if (chunk.done) {
            cleanup();
            resolve(text + decoder.decode());
            return;
          }
          text += decoder.decode(chunk.value, { stream: true });
          arm(stallTimeoutMs, "stall");
        }
      })();
    });
  } finally {
    cleanup();
  }
}
