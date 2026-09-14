import { describe, it, expect } from "vitest";
import {
  shouldDisableOnBadResponse,
  isAuthBrokenConnection,
  isSkipOnlyRotationError,
} from "@/sse/services/auth.js";

// Real lastError captured from the DB for openai-compatible-chat-65f09875… (api.b.ai)
const BAI =
  '[400]: {"error":{"message":"credit insufficient balance: balance=0 required=4560 (request id: 20260914160932263413297c955d568y49kmUQ8)"}}';

describe("bad-account auto-disable (403/402/insufficient)", () => {
  it("disables on 403, 402, and on insufficient-balance bodies even when status is 400", () => {
    expect(shouldDisableOnBadResponse(403, "permission denied")).toBe(true);
    expect(shouldDisableOnBadResponse(402, "payment required")).toBe(true);
    expect(shouldDisableOnBadResponse(400, BAI)).toBe(true);
    expect(shouldDisableOnBadResponse(400, "insufficient quota")).toBe(true);
  });

  it("never disables on content / transient errors", () => {
    expect(
      shouldDisableOnBadResponse(400, "This model's maximum prompt length is 500000 but the request contains 600000"),
    ).toBe(false);
    expect(shouldDisableOnBadResponse(500, "upstream died")).toBe(false);
    expect(isSkipOnlyRotationError(502, "bad gateway")).toBe(true);
  });

  it("treats a stale insufficient-balance marker as pool-dead so selection disables it", () => {
    expect(isAuthBrokenConnection({ isActive: true, apiKey: "k", lastError: BAI, errorCode: 400 })).toBe(true);
    expect(
      isAuthBrokenConnection({ isActive: true, apiKey: "k", lastError: "upstream died", errorCode: 500 }),
    ).toBe(false);
  });
});
