/**
 * Skip-only rotation errors must never disable accounts:
 *  - 400 + maximum prompt length
 *  - 500 / 502 upstream blips
 */
import { describe, it, expect } from "vitest";
import {
  isSkipOnlyRotationError,
  shouldDisableOnBadResponse,
  isAuthBrokenConnection,
} from "../../src/sse/services/auth.js";

describe("isSkipOnlyRotationError", () => {
  it("flags 500 and 502", () => {
    expect(isSkipOnlyRotationError(500, "Internal server error")).toBe(true);
    expect(isSkipOnlyRotationError(502, "Bad gateway")).toBe(true);
  });

  it("flags 400 maximum prompt length", () => {
    const msg =
      "This model's maximum prompt length is 500000 but the request contains 503074 tokens.";
    expect(isSkipOnlyRotationError(400, msg)).toBe(true);
    expect(isSkipOnlyRotationError(400, "input is too long")).toBe(true);
  });

  it("does NOT flag free-usage 429", () => {
    expect(
      isSkipOnlyRotationError(
        429,
        'subscription:free-usage-exhausted — used all the included free usage',
      ),
    ).toBe(false);
  });

  it("does NOT flag 401 auth death", () => {
    expect(isSkipOnlyRotationError(401, "unauthorized")).toBe(false);
  });
});

describe("shouldDisableOnBadResponse", () => {
  it("never disables on skip-only classes", () => {
    expect(
      shouldDisableOnBadResponse(
        400,
        "This model's maximum prompt length is 500000 but the request contains 503074 tokens.",
      ),
    ).toBe(false);
    expect(shouldDisableOnBadResponse(500, "boom")).toBe(false);
    expect(shouldDisableOnBadResponse(502, "bad gateway")).toBe(false);
  });

  it("still disables free-usage and auth death", () => {
    expect(
      shouldDisableOnBadResponse(
        429,
        '{"code":"subscription:free-usage-exhausted","error":"You\'ve used all the included free usage"}',
      ),
    ).toBe(true);
    expect(shouldDisableOnBadResponse(401, "unauthorized")).toBe(true);
    expect(shouldDisableOnBadResponse(402, "payment required")).toBe(true);
  });
});

describe("isAuthBrokenConnection + skip-only lastError", () => {
  const base = {
    id: "x",
    isActive: true,
    accessToken: "at",
    refreshToken: "rt",
  };

  it("does not treat skip-only lastError as auth-broken", () => {
    expect(
      isAuthBrokenConnection({
        ...base,
        testStatus: "unavailable",
        errorCode: 400,
        lastError:
          "This model's maximum prompt length is 500000 but the request contains 503074 tokens.",
      }),
    ).toBe(false);
    expect(
      isAuthBrokenConnection({
        ...base,
        testStatus: "unavailable",
        errorCode: 500,
        lastError: "Internal server error",
      }),
    ).toBe(false);
  });

  it("still treats free-usage lastError as broken", () => {
    expect(
      isAuthBrokenConnection({
        ...base,
        testStatus: "error",
        errorCode: 429,
        lastError: "free-usage-exhausted",
      }),
    ).toBe(true);
  });

  it("still treats isActive=false as broken", () => {
    expect(isAuthBrokenConnection({ ...base, isActive: false })).toBe(true);
  });
});
