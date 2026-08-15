/**
 * QoderExecutor — sends OpenAI-format chat requests to Qoder's COSY-signed
 * inference endpoint at api2.qoder.sh, then unwraps Qoder's `{statusCodeValue,
 * body}` SSE envelope back into plain OpenAI SSE for the rest of the pipeline.
 *
 * Differences vs the previous placeholder:
 *   - URL is api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
 *     with `&Encode=1` so we can ship the body through the WAF-bypass
 *     encoder.
 *   - Authentication is COSY (RSA + AES + MD5 + ~17 Cosy-* headers), not
 *     a static HMAC.
 *   - The request shape Qoder expects is non-trivial (chat_context with
 *     mirrored modelConfig, business block with stable IDs, system text
 *     hoisted out of the messages array). All ported from the reference.
 *   - Model identifier is one of the canonical Qoder keys (auto / ultimate /
 *     performance / efficient / lite + frontier "*model" ids); the
 *     translator layer feeds us "qoder/<key>" so we strip the prefix.
 *   - Per-model `model_config` is fetched live from /algo/api/v2/model/list
 *     and cached. Sending the wrong block silently downgrades to a
 *     different model upstream, so a missing entry is a hard error.
 */

import { buildCosyHeaders } from "../shared/qoder/cosy.js";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import {
  QODER_CHAT_URL_ENCODED,
  QODER_MODEL_MAP,
} from "../shared/qoder/constants.js";
import { getQoderModelConfig, resolveQoderModels } from "../services/qoderModels.js";

/**
 * Hoist role:"system" messages out of the messages array (Qoder rejects
 * system in messages) and flatten any multipart content arrays.
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], systemText: "" };
  }
  const systemParts = [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const text = extractText(msg.content);
    if (msg.role === "system") {
      if (text) systemParts.push(text);
      continue;
    }
    const cloned = { ...msg };
    cloned.content = text;
    out.push(cloned);
  }
  return { messages: out, systemText: systemParts.join("\n\n") };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        if (item.type === "text" && typeof item.text === "string") {
          parts.push(item.text);
        } else if (typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

function stableHash(prefix, ...parts) {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(String(p ?? ""));
  }
  return h.digest("hex").slice(0, 16);
}

function stableChatRecordId(model, messages, tools, maxTokens) {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(String(model));
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role) { h.update("\0"); h.update(m.role); }
    if (typeof m.content === "string" && m.content) {
      h.update("\0"); h.update(m.content);
    }
  }
  if (tools) {
    h.update("\0");
    try { h.update(JSON.stringify(tools)); } catch {}
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/**
 * Map the OpenAI-style request body into the exact shape Qoder expects.
 */
async function buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal }) {
  const qoderKey = String(model || "").replace(/^qoder\//, "");
  
  // Fetch model config from dynamic API instead of relying on static QODER_MODEL_MAP.
  // This allows support for new Qoder models (e.g., qmodel_latest) without code changes.
  let modelConfig = await getQoderModelConfig(credentials, qoderKey, { log, proxyOptions, signal });
  if (!modelConfig) {
    // Try a forced refresh once before giving up — the cache may simply
    // not be populated yet on first ever call for this credential.
    const refreshed = await resolveQoderModels(credentials, { forceRefresh: true, log, proxyOptions, signal });
    const retried = refreshed?.rawConfigs.get(qoderKey);
    if (!retried) {
      throw new Error(
        `qoder: model_config for "${qoderKey}" not yet known (run a model list fetch or check upstream connectivity)`,
      );
    }
    modelConfig = { ...retried, key: qoderKey };
  }

  const { messages, systemText } = normalizeMessages(body.messages || []);
  const tools = body.tools;
  const isReasoning = !!modelConfig.is_reasoning;
  const maxOutputTokens = Number(modelConfig.max_output_tokens) || 0;

  let maxTokens = 32_768;
  if (maxOutputTokens > 0) maxTokens = maxOutputTokens;
  if (typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens < maxTokens) {
    maxTokens = body.max_tokens;
  }
  if (typeof body.max_completion_tokens === "number" && body.max_completion_tokens > 0 && body.max_completion_tokens < maxTokens) {
    maxTokens = body.max_completion_tokens;
  }

  const lastUser = lastUserText(messages);
  const psd = credentials.providerSpecificData || {};
  const sessionId = stableHash("qoder-session", psd.userId, qoderKey);
  const recordId = stableChatRecordId(qoderKey, messages, tools, maxTokens);

  return {
    qoderKey,
    payload: {
      request_id: uuidv4(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT", // MUST match binary exactly — custom chat_task fails agent_router
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli", // MUST match binary exactly — upstream router rejects custom values
      agent_id: "agent_common", // MUST match binary exactly — agent_router flow nodes depend on this
      task_id: "common",        // MUST match binary exactly
      code_language: "",        // Empty like binary
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: systemText,
      messages,
      tools: Array.isArray(tools) ? tools : [],
      parameters: { max_tokens: maxTokens },
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: qoderKey, is_reasoning: isReasoning },
          originalContent: lastUser,
        },
        features: [],
        text: lastUser,
      },
      model_config: modelConfig,
      business: {
        product: "cli",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: uuidv4(),
        name: truncate(lastUser, 30),
        begin_at: Date.now(),
      },
    },
    modelConfig,
  };
}

/**
 * Peek the first `data:` SSE envelope from an upstream response WITHOUT
 * consuming the stream. Uses body.tee() so one branch is read for detection
 * and the other branch is returned untouched for the caller to pipe through
 * wrapQoderSSE.
 *
 * @returns {{ response: Response, envelope: object|null }} — response carries
 *   the untouched body branch; envelope is the parsed first envelope (or null
 *   when the stream produced no parseable envelope before end).
 */
async function peekFirstSSEEnvelope(response) {
  if (!response?.body) return { response, envelope: null };
  const [peekBranch, passBranch] = response.body.tee();
  const passResponse = new Response(passBranch, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  const reader = peekBranch.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let envelope = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trimStart();
        if (data === "[DONE]") { reader.cancel().catch(() => {}); return { response: passResponse, envelope: null }; }
        try {
          const env = JSON.parse(data);
          if (env && typeof env.statusCodeValue === "number") {
            // Healthy envelope (200) — no error to surface. Cancel read and
            // report null so callers forward the stream untouched.
            if (env.statusCodeValue === 200) {
              reader.cancel().catch(() => {});
              return { response: passResponse, envelope: null };
            }
            envelope = env;
            reader.cancel().catch(() => {});
            return { response: passResponse, envelope };
          }
        } catch { /* non-JSON data line — keep scanning */ }
      }
    }
  } catch { /* stream error — treat as no envelope */ } finally {
    reader.releaseLock();
  }
  return { response: passResponse, envelope: null };
}

function wrapQoderSSE(response, model) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let doneEmitted = false;

  // Process one already-extracted SSE line (no trailing newline). Returns
  // false when the line indicated end-of-stream so the caller can stop
  // forwarding any remaining chunks after [DONE].
  const processLine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("data:")) return;
    if (doneEmitted) return; // never forward chunks past stream end

    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") {
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }

    let envelope;
    try { envelope = JSON.parse(data); } catch { return; }
    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";
    if (statusVal !== 200) {
      const msg = inner || `upstream status ${statusVal}`;
      const errChunk = JSON.stringify({
        id: `qoder-error-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: `\n[qoder error ${statusVal}: ${truncate(msg, 200)}]` }, finish_reason: "stop" }],
      });
      controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }
    if (!inner) return;
    if (inner === "[DONE]") {
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }
    // Inner is an OpenAI-shaped chunk. Strip any embedded newlines so the
    // SSE frame stays a single event (a literal "\n" inside `inner` would
    // otherwise split the frame across multiple data: lines and downstream
    // parsers would reassemble them as separate events).
    const sanitized = inner.replace(/\r?\n/g, "");
    controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        processLine(line, controller);
      }
    },
    flush(controller) {
      // Finalize the decoder so any pending multi-byte sequence is
      // released into `buffer` instead of being silently dropped.
      buffer += decoder.decode();
      // Drain any trailing line that arrived without a terminating newline
      // (e.g. upstream closed the socket immediately after the last write,
      // or a CDN stripped the final CRLF). Without this, the chunk that
      // carries finish_reason is silently lost.
      if (buffer.length > 0) {
        processLine(buffer, controller);
        buffer = "";
      }
      if (!doneEmitted) {
        controller.enqueue(encoder.encode(SSE_DONE));
        doneEmitted = true;
      }
    },
  });

  const transformed = response.body.pipeThrough(transform);
  // Build a Response with passable headers; the streaming handler reads
  // `.body` as a ReadableStream regardless of Content-Type.
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

export class QoderExecutor extends BaseExecutor {
  constructor() {
    super("qoder", PROVIDERS.qoder);
  }

  buildUrl() {
    return QODER_CHAT_URL_ENCODED;
  }

  // Override execute entirely — Qoder needs:
  //   - body built from translated chat completion payload
  //   - body encoded with QoderEncodeBody before signing
  //   - COSY headers built from the *encoded* body bytes
  //   - response stream re-wrapped from {statusCodeValue, body} to OpenAI SSE
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl();

    const psd = credentials?.providerSpecificData || {};
    if (!psd.userId) {
      // No user id → no way to sign. Surface a 401 so the dashboard nudges
      // the user back to OAuth.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing userId; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }
    if (!credentials?.accessToken) {
      // Same shape as the userId guard — clean 401 so chatCore reports
      // "reconnect" rather than bubbling cosy.js's synchronous throw as 500.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing accessToken; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    let qoderKey;
    let payload;
    try {
      ({ qoderKey, payload } = await buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal }));
    } catch (err) {
      const fakeResp = new Response(
        JSON.stringify({ error: { message: err.message } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    // Binary (1.1.14) sends the RAW JSON body for chat — no qoderEncodeBody.
    // Raw body + streaming headers matching opencode executor pattern.
    const sendBuf = Buffer.from(JSON.stringify(payload), "utf8");

    let cosyHeaders;
    try {
      cosyHeaders = buildCosyHeaders(
        sendBuf,
        url,
        {
          userId: psd.userId,
          authToken: credentials.accessToken,
          name: credentials.displayName || "",
          email: credentials.email || "",
          machineId: psd.machineId || "",
        },
      );
    } catch (err) {
      // cosy.js throws synchronously on missing userId/authToken — surface
      // as 401 so chatCore prompts re-auth instead of returning a 500.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: `qoder cosy signing failed: ${err.message}` } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    const modelSource = (payload.model_config && payload.model_config.source) || "system";
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
        // Optimized for streaming + retry like opencode provider
      "Connection": "keep-alive",  // Connection reuse
      "Cache-Control": "no-cache", // Fresh responses
      "X-Model-Key": qoderKey,
      "X-Model-Source": modelSource,
      "Accept-Encoding": "identity", // No gzip (signature validation)
      ...cosyHeaders,
    };

    // Connect timeout + stall timeout with retry logic matching binary behavior
    const configTimeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
    const stallTimeoutMs = this.config?.stallTimeoutMs || 120000; // 120s stall detection
    const enableRetry = !!this.config?.retryOnTimeout;
    const maxRetryAttempts = this.config?.maxRetryAttempts ?? 2;

    let attempt = 0;
    while (true) {
      attempt += 1;

      const isConnectAttempt = attempt === 1;
      const currentTimeoutMs = isConnectAttempt ? configTimeoutMs : stallTimeoutMs;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error(isConnectAttempt ? "connect timeout" : "stall timeout")), currentTimeoutMs);
      const mergedSignal = signal
        ? AbortSignal.any([signal, isConnectAttempt ? ctrl.signal : AbortSignal.timeout(Infinity)])
        : (isConnectAttempt ? ctrl.signal : AbortSignal.timeout(Infinity));

      try {
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: sendBuf,
          signal: mergedSignal,
        });
        clearTimeout(timer);

        // Check for recoverable errors (408/429/5xx) — retry if attempts remaining
        const statusCode = response.status;
        const isRecoverable = statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode < 600);

        if (!response.ok && !isRecoverable) {
          // Non-recoverable (auth failure) — pass through
          return { response, url, headers, transformedBody: payload };
        }

        if (!response.ok) {
          log.warn(`QODER`, `qoder | attempt ${attempt}/${maxRetryAttempts} failed (status ${statusCode})`);
          if (attempt >= maxRetryAttempts || !enableRetry) {
            return { response, url, headers, transformedBody: payload };
          }
          // Retry after exponential backoff
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }

        // Success or wrapped content — proceed
        const { response: peekedResponse, envelope } = await peekFirstSSEEnvelope(response);
        if (envelope && envelope.statusCodeValue !== 200) {
          const msg = typeof envelope.body === "string" ? envelope.body : `qoder upstream ${envelope.statusCodeValue}`;
          const errResp = new Response(
            JSON.stringify({ error: { message: msg, code: String(envelope.statusCodeValue) } }),
            { status: Number(envelope.statusCodeValue) >= 400 ? Number(envelope.statusCodeValue) : 502, headers: { "Content-Type": "application/json" } },
          );
          return { response: errResp, url, headers, transformedBody: payload };
        }

        const wrapped = wrapQoderSSE(peekedResponse, `qoder/${qoderKey}`);
        return { response: wrapped, url, headers, transformedBody: payload };
      } catch (err) {
        clearTimeout(timer);

        // Timeout/stall error — retry if attempts remaining
        if (!err.message.includes("timeout") && err.name !== "AbortError") throw err;

        log.warn(`QODER`, `qoder | attempt ${attempt}/${maxRetryAttempts} timeout (${err.message})`);

        if (enableRetry && attempt < maxRetryAttempts) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }

        // Max retries reached — failover
        return {
          response: new Response(JSON.stringify({ error: { message: err.message } }), { status: 504 }),
          url,
          headers,
          transformedBody: payload,
        };
      }
    }

    if (!response.ok) {
      // Pass error response through unchanged so chatCore can capture it.
      return { response, url, headers, transformedBody: payload };
    }

    // Peek the first upstream SSE chunk. Qoder wraps upstream errors inside
    // the SSE envelope ({statusCodeValue:403, body:...}) with HTTP 200 — if we
    // forward that as streamed content, chatCore's `!response.ok` check never
    // fires and the account is never disabled/rotated. Detect the error
    // envelope here and surface a real non-ok Response so markAccountUnavailable
    // sees the 403 and disables the account (fallback to next).
    const { response: peekedResponse, envelope } = await peekFirstSSEEnvelope(response);
    if (envelope && envelope.statusCodeValue !== 200) {
      const msg = typeof envelope.body === "string" ? envelope.body : `qoder upstream ${envelope.statusCodeValue}`;
      const errResp = new Response(
        JSON.stringify({ error: { message: msg, code: String(envelope.statusCodeValue) } }),
        { status: Number(envelope.statusCodeValue) >= 400 ? Number(envelope.statusCodeValue) : 502, headers: { "Content-Type": "application/json" } },
      );
      return { response: errResp, url, headers, transformedBody: payload };
    }

    const wrapped = wrapQoderSSE(peekedResponse, `qoder/${qoderKey}`);
    return { response: wrapped, url, headers, transformedBody: payload };
  }

  // Qoder device tokens don't refresh through OAuth — the upstream returns
  // 403 for our flow. Surfacing failure via 401-on-chat is enough; the
  // dashboard tells users to re-login when their token expires (~30 days).
  async refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }
}

export default QoderExecutor;

// Internals exposed for unit tests. Not part of the public API — callers
// should import QoderExecutor and use its public methods.
export const __test__ = {
  normalizeMessages,
  wrapQoderSSE,
  peekFirstSSEEnvelope,
  buildQoderRequestBody,
};
