/**
 * Direct route: OpenAI Responses API stream → Claude Messages SSE (response).
 *
 * Used only for grok-cli / gcli (see translateResponse provider allowlist in index.js).
 * Composes existing Responses→OpenAI and OpenAI→Claude chunk mappers so behavior
 * matches the previous double-hop while using the direct registry path.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { openaiResponsesToOpenAIResponse } from "./openai-responses.js";
import { openaiToClaudeResponse } from "./openai-to-claude.js";

/**
 * @param {object|null} chunk - Parsed Responses SSE payload (or null to flush)
 * @param {object} state - Stream state (shared; both mappers mutate it)
 * @returns {Array|null} Claude SSE event objects
 */
export function openaiResponsesToClaudeResponse(chunk, state) {
  // Responses → OpenAI chat chunk(s)
  const openaiChunk = openaiResponsesToOpenAIResponse(chunk, state);
  if (openaiChunk == null) return null;

  const openaiChunks = Array.isArray(openaiChunk) ? openaiChunk : [openaiChunk];
  const claudeEvents = [];

  for (const oc of openaiChunks) {
    if (oc == null) continue;
    const converted = openaiToClaudeResponse(oc, state);
    if (!converted) continue;
    if (Array.isArray(converted)) claudeEvents.push(...converted);
    else claudeEvents.push(converted);
  }

  return claudeEvents.length > 0 ? claudeEvents : null;
}

// Response-only registration (request direction registered in request/claude-to-openai-responses.js).
// Key for responseRegistry is target:source → openai-responses:claude
register(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, null, openaiResponsesToClaudeResponse);
