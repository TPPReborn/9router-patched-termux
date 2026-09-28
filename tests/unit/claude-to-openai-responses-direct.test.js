/**
 * Direct claude → openai-responses route (scoped to grok-cli/gcli).
 */
import { describe, it, expect } from "vitest";
import {
  translateRequest,
  translateResponse,
  initState,
  isGrokCliDirectResponsesProvider,
} from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("isGrokCliDirectResponsesProvider", () => {
  it("allows only grok-cli aliases", () => {
    expect(isGrokCliDirectResponsesProvider("grok-cli")).toBe(true);
    expect(isGrokCliDirectResponsesProvider("gcli")).toBe(true);
    expect(isGrokCliDirectResponsesProvider("codex")).toBe(false);
    expect(isGrokCliDirectResponsesProvider("claude")).toBe(false);
    expect(isGrokCliDirectResponsesProvider(null)).toBe(false);
  });
});

describe("claude → openai-responses request (grok-cli only)", () => {
  const claudeBody = {
    model: "claude-proxy",
    max_tokens: 1024,
    stream: true,
    system: "You are helpful.",
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "/tmp/a" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "file contents",
          },
        ],
      },
    ],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
      },
    ],
    reasoning_effort: "xhigh",
  };

  it("produces Responses shape for provider=grok-cli", () => {
    const out = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI_RESPONSES,
      "grok-4.5",
      structuredClone(claudeBody),
      true,
      null,
      "grok-cli",
    );

    expect(out).toBeTruthy();
    expect(Array.isArray(out.input)).toBe(true);
    expect(out.input.length).toBeGreaterThan(0);
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
    expect(out.instructions).toContain("helpful");
    // Grok executor allowlist: max_output_tokens not max_tokens.
    // adjustMaxTokens() may raise the client budget (e.g. 1024 → 32000).
    expect(out.max_output_tokens).toBeGreaterThanOrEqual(1024);
    expect(out.max_tokens).toBeUndefined();
    expect(out.messages).toBeUndefined();
    // tools flattened for Responses
    expect(out.tools?.length).toBe(1);
    expect(out.tools[0].name).toBe("Read");
    // effort preserved for executor
    expect(out.reasoning?.effort || out.reasoning_effort).toBeTruthy();

    const roles = out.input.map((i) => i.role || i.type);
    expect(roles).toContain("user");
  });

  it("matches double-hop shape for provider=codex (still pivots)", () => {
    const direct = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI_RESPONSES,
      "grok-4.5",
      structuredClone(claudeBody),
      true,
      null,
      "grok-cli",
    );
    const pivot = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI_RESPONSES,
      "grok-4.5",
      structuredClone(claudeBody),
      true,
      null,
      "codex",
    );
    // Both should be Responses bodies with input[]
    expect(Array.isArray(direct.input)).toBe(true);
    expect(Array.isArray(pivot.input)).toBe(true);
    // Direct path normalizes max_output_tokens; pivot may still carry max_tokens
    // until executor — for codex that's fine. Core input roles should agree.
    const dUsers = direct.input.filter((i) => i.role === "user").length;
    const pUsers = pivot.input.filter((i) => i.role === "user").length;
    expect(dUsers).toBe(pUsers);
  });
});

describe("openai-responses → claude response (grok-cli only)", () => {
  it("maps text delta events to Claude content_block events", () => {
    const state = {
      ...initState(FORMATS.CLAUDE),
      provider: "grok-cli",
    };

    // First Responses event: text delta (after mappers init)
    const events1 = translateResponse(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.CLAUDE,
      { type: "response.output_text.delta", delta: "Hel" },
      state,
    );
    expect(Array.isArray(events1)).toBe(true);
    expect(events1.some((e) => e?.type === "message_start")).toBe(true);
    expect(
      events1.some(
        (e) => e?.type === "content_block_delta" && e?.delta?.type === "text_delta",
      ),
    ).toBe(true);

    const events2 = translateResponse(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.CLAUDE,
      { type: "response.output_text.delta", delta: "lo" },
      state,
    );
    expect(
      events2.some(
        (e) => e?.delta?.text === "lo" || e?.delta?.type === "text_delta",
      ),
    ).toBe(true);

    // completed → finish
    const events3 = translateResponse(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.CLAUDE,
      {
        type: "response.completed",
        response: {
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      state,
    );
    expect(events3.some((e) => e?.type === "message_delta")).toBe(true);
    expect(events3.some((e) => e?.type === "message_stop")).toBe(true);
  });

  it("does not use direct route for codex (no crash; pivot still works)", () => {
    const state = {
      ...initState(FORMATS.CLAUDE),
      provider: "codex",
    };
    const events = translateResponse(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.CLAUDE,
      { type: "response.output_text.delta", delta: "x" },
      state,
    );
    // pivot path still produces claude events
    expect(Array.isArray(events)).toBe(true);
    expect(events.some((e) => e?.type === "message_start" || e?.type === "content_block_delta")).toBe(
      true,
    );
  });
});
