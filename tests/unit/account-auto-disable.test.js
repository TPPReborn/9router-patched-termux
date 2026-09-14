import { describe, it, expect } from "vitest";
import {
  shouldDisableOnBadResponse,
  isAuthBrokenConnection,
  isSkipOnlyRotationError,
} from "@/sse/services/auth.js";

// Real bodies captured from api.b.ai (openai-compatible-chat-65f09875…)
const BAI_400 =
  '[400]: {"error":{"message":"credit insufficient balance: balance=0 required=4560 (request id: 20260914160932263413297c955d568y49kmUQ8)","code":"insufficient_user_quota"}}';
const BAI_GATE_403 =
  '[403]: {"error":{"code":"access_denied","message":"Access restricted. Deposit required to unlock premium model"}}';

describe("bad-account auto-disable (400/402/403)", () => {
  it("disables on 402/403 and on 400 with an account-fault body", () => {
    expect(shouldDisableOnBadResponse(403, "permission denied")).toBe(true);
    expect(shouldDisableOnBadResponse(402, "payment required")).toBe(true);
    expect(shouldDisableOnBadResponse(400, BAI_400)).toBe(true);
    expect(shouldDisableOnBadResponse(400, "insufficient quota")).toBe(true);
    expect(isAuthBrokenConnection({ isActive: true, apiKey: "k", lastError: BAI_400, errorCode: 400 })).toBe(true);
  });

  it("never disables on content / transient / plain request errors", () => {
    expect(
      shouldDisableOnBadResponse(400, "This model's maximum prompt length is 500000 but the request contains 600000"),
    ).toBe(false);
    expect(shouldDisableOnBadResponse(400, "invalid type: expected string, got object")).toBe(false);
    expect(shouldDisableOnBadResponse(500, "upstream died")).toBe(false);
    expect(isSkipOnlyRotationError(502, "bad gateway")).toBe(true);
    expect(isAuthBrokenConnection({ isActive: true, apiKey: "k", lastError: "upstream died", errorCode: 500 })).toBe(false);
  });

  it("treats a per-model paywall (403 deposit-required) as skip-only, not account death", () => {
    expect(isSkipOnlyRotationError(403, BAI_GATE_403)).toBe(true);
    expect(shouldDisableOnBadResponse(403, BAI_GATE_403)).toBe(false);
    // With no prior error state the account must stay in the pool.
    expect(isAuthBrokenConnection({ isActive: true, apiKey: "k" })).toBe(false);
    // isAuthBrokenConnection ignores a stale skip-only marker (model lock handles it).
    expect(isAuthBrokenConnection({ isActive: true, apiKey: "k", lastError: BAI_GATE_403, errorCode: 403 })).toBe(false);
  });
});
