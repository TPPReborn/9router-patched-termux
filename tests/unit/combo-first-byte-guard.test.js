import { describe, it, expect, vi } from "vitest";
import { attemptWithFirstByteGuard, handleComboChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function sseResponse(chunks, { status = 200, delayMs = 0, endImmediately = false } = {}) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        if (endImmediately) { controller.close(); return; }
        for (const c of chunks) {
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
        }
        controller.close();
      },
    }),
    { status, headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
  );
}

const TOKEN_FRAMES =
  'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
  'data: [DONE]\n\n';

describe("attemptWithFirstByteGuard", () => {
  it("fails over when upstream sends an immediate in-band error frame", async () => {
    const bad = sseResponse([
      'data: {"error":{"message":"FreeTierError upstream","code":403}}\n\n',
    ]);
    const result = await attemptWithFirstByteGuard(
      {}, "m1", async () => bad, log, 2000,
    );
    expect(result.__comboFirstByteFailure).toBe(true);
    expect(result.reason).toMatch(/error frame/);
    expect(result.reason).toMatch(/FreeTierError/);
  });

  it("fails over when the stream hangs without sending any byte", async () => {
    // Never-enqueued, never-closed stream + 150ms guard.
    const hung = new Response(
      new ReadableStream({ start() { /* intentionally never pushes */ } }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const started = Date.now();
    const result = await attemptWithFirstByteGuard(
      {}, "m1", async () => hung, log, 150,
    );
    expect(result.__comboFirstByteFailure).toBe(true);
    expect(result.reason).toMatch(/no bytes/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("replays buffered bytes losslessly then continues live", async () => {
    const enc = new TextEncoder();
    const upstream = sseResponse([
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const resp = await attemptWithFirstByteGuard({}, "m1", async () => upstream, log, 5000);
    expect(resp.__comboFirstByteFailure).toBeUndefined();
    expect(resp.ok).toBe(true);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    const text = await new Response(resp.body).text();
    expect(text).toBe('data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n');
    expect(enc.encode(text).length).toBeGreaterThan(0);
  });

  it("fails over when the stream ends immediately with no data", async () => {
    const empty = sseResponse([], { endImmediately: true });
    const result = await attemptWithFirstByteGuard(
      {}, "m1", async () => empty, log, 2000,
    );
    expect(result.__comboFirstByteFailure).toBe(true);
    expect(result.reason).toMatch(/ended without any data/);
  });

  it("fails over when the stream ends having sent only heartbeats (no data)", async () => {
    const heartbeats = sseResponse([
      ": ping\n\n",
      ": ping\n\n",
    ]);
    const result = await attemptWithFirstByteGuard(
      {}, "m1", async () => heartbeats, log, 2000,
    );
    expect(result.__comboFirstByteFailure).toBe(true);
    expect(result.reason).toMatch(/ended without any data/);
  });

  it("commits a still-open stream that only sent heartbeats within the window", async () => {
    // Pings arrive, then silence, but the stream never closes → deadline hit
    // with non-empty text. Commit conservatively (stall guards bound the wait).
    const enc = new TextEncoder();
    const streaming = new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(enc.encode(": ping\n\n"));
          // stays open forever — guard must decide at the deadline
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const result = await attemptWithFirstByteGuard(
      {}, "m1", async () => streaming, log, 250,
    );
    expect(result.__comboFirstByteFailure).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("does not probe JSON (non-SSE) responses", async () => {
    const json = new Response(JSON.stringify({ ok: 1 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
    const result = await attemptWithFirstByteGuard(
      {}, "m1", async () => json, log, 100,
    );
    expect(result.__comboFirstByteFailure).toBeUndefined();
    expect(await result.json()).toEqual({ ok: 1 });
  });

  it("rethrows sync throws (preserves existing loop behavior)", async () => {
    await expect(
      attemptWithFirstByteGuard({}, "m1", async () => { throw new Error("boom"); }, log, 500),
    ).rejects.toThrow("boom");
  });
});

describe("handleComboChat + first-byte guard", () => {
  it("falls back to the next model when the first stream dies pre-first-byte", async () => {
    const handleSingleModel = vi.fn();
    // Model A: hang. Model B: healthy.
    handleSingleModel.mockImplementation(async (body, modelStr) => {
      if (modelStr === "prov/a") {
        return new Response(
          new ReadableStream({ start() { /* hang */ } }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return sseResponse(['data: {"choices":[{"delta":{"content":"fallback ok"}}]}\n\ndata: [DONE]\n\n']);
    });

    const resp = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["prov/a", "prov/b"],
      handleSingleModel,
      log,
      comboName: "t",
      comboStrategy: "fallback",
      firstByteTimeoutMs: 200,
    });

    // First attempt hung; combo must have moved on and served via model B.
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(resp.ok).toBe(true);
    const text = await new Response(resp.body).text();
    expect(text).toContain("fallback ok");
  });
});
