import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/messages - Claude format (auto convert via handleChat)
 */
export async function POST(request) {
  await ensureInitialized();
  const response = await handleChat(request);
  // Anthropic clients expect the `{"type":"error","error":{...}}` envelope; the
  // shared error path emits the OpenAI shape. Reshape 4xx/5xx JSON bodies here
  // so any SDK parsing an Anthropic error never sees a foreign shape.
  if (!response.ok && (response.headers.get("content-type") || "").includes("application/json")) {
    try {
      const body = await response.json();
      if (body?.error && body.type !== "error") {
        const anthropicError = {
          type: "error",
          error: {
            type: body.error.type || (response.status >= 500 ? "api_error" : "invalid_request_error"),
            message: body.error.message || "An error occurred"
          }
        };
        if (body.error.code) anthropicError.error.code = body.error.code;
        return new Response(JSON.stringify(anthropicError), {
          status: response.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...(response.headers.get("retry-after") ? { "Retry-After": response.headers.get("retry-after") } : {}) }
        });
      }
      // Body was consumed but did not need reshaping — rebuild it as-is.
      return new Response(JSON.stringify(body), { status: response.status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    } catch { /* not JSON after all — fall through with original */ }
  }
  return response;
}

