import { describe, it, expect } from "vitest";
import { openAICompletionToClaudeMessage } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

// Regression: a Claude-format client (/v1/messages, stream:false) that hits a
// forceStream provider (e.g. opencode) receives SSE → JSON via sseToJsonHandler.
// That handler must convert the OpenAI body to an Anthropic `message` — here we
// pin the converter used on both the true non-streaming path and the injected
// forced-SSE path.
describe("openAICompletionToClaudeMessage", () => {
  it("converts a chat.completion body to an Anthropic message", () => {
    const openai = {
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1,
      model: "mimo-v2.6-flash-free",
      choices: [{ index: 0, message: { role: "assistant", content: "PONG" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    };
    const out = openAICompletionToClaudeMessage(openai);
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.model).toBe("mimo-v2.6-flash-free");
    expect(out.stop_reason).toBe("end_turn");
    expect(out.content).toEqual([{ type: "text", text: "PONG" }]);
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
  });

  it("maps tool_calls to tool_use blocks and finish_reason to tool_use", () => {
    const openai = {
      id: "chatcmpl-9",
      object: "chat.completion",
      model: "m",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Jakarta"}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: {},
    };
    const out = openAICompletionToClaudeMessage(openai);
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content[0].type).toBe("tool_use");
    expect(out.content[0].input).toEqual({ city: "Jakarta" });
  });

  it("preserves reasoning_content as a thinking block when content is empty", () => {
    const openai = {
      id: "chatcmpl-7",
      object: "chat.completion",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "", reasoning_content: "hidden thought" }, finish_reason: "stop" }],
      usage: {},
    };
    const out = openAICompletionToClaudeMessage(openai);
    expect(out.content[0].type).toBe("thinking");
    expect(out.content[0].thinking).toBe("hidden thought");
  });
});
