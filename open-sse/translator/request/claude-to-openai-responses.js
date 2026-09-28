/**
 * Direct route: Claude Messages → OpenAI Responses API (request).
 *
 * Used only for grok-cli / gcli (see translateRequest provider allowlist in index.js).
 * Other openai-responses providers (e.g. codex) keep the OpenAI pivot.
 *
 * Implementation: compose existing mappers for behavioral parity with the
 * previous double-hop, then fix max_tokens → max_output_tokens for the
 * Grok Responses allowlist (executor strips max_tokens).
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { claudeToOpenAIRequest } from "./claude-to-openai.js";
import { openaiToOpenAIResponsesRequest } from "./openai-responses.js";

/**
 * @param {string} model
 * @param {object} body - Claude /v1/messages body
 * @param {boolean} stream
 * @param {object|null} credentials
 */
export function claudeToOpenAIResponsesRequest(model, body, stream, credentials) {
  const openaiBody = claudeToOpenAIRequest(model, body, stream);
  const result = openaiToOpenAIResponsesRequest(model, openaiBody, stream, credentials);

  // GrokCliExecutor allowlist accepts max_output_tokens, not max_tokens.
  // Double-hop previously left max_tokens which the executor then deleted.
  if (result && typeof result === "object") {
    if (result.max_output_tokens == null && result.max_tokens != null) {
      result.max_output_tokens = result.max_tokens;
    }
    delete result.max_tokens;
  }

  return result;
}

// Request-only registration. Response side is openai-responses-to-claude.js.
// Provider scoping is enforced in translateRequest (grok-cli / gcli only).
register(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, claudeToOpenAIResponsesRequest, null);
