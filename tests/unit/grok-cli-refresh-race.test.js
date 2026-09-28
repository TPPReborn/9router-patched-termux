/**
 * Grok-cli single-use RT race: stale in-memory RT must adopt DB rotation
 * under the refresh gate — never hit network with RT_OLD.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("Grok CLI invalid_grant prevention", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("refreshLeadMs is 30 minutes", async () => {
    const { getRefreshLeadMs } = await import(
      "../../open-sse/services/tokenRefresh.js"
    );
    expect(getRefreshLeadMs("grok-cli")).toBe(30 * 60 * 1000);
  });

  it("isUnrecoverableRefreshError flags invalid_grant", async () => {
    const { isUnrecoverableRefreshError } = await import(
      "../../open-sse/services/tokenRefresh.js"
    );
    expect(isUnrecoverableRefreshError({ error: "invalid_grant" })).toBe(true);
    expect(isUnrecoverableRefreshError({ error: "network" })).toBe(false);
  });

  it("loader adopt: stale RT under gate returns DB tokens without network", async () => {
    const {
      setConnectionLoader,
      refreshProviderCredentials,
    } = await import("../../open-sse/services/oauthCredentialManager.js");

    setConnectionLoader(async () => ({
      id: "c1",
      isActive: true,
      refreshToken: "RT_NEW",
      accessToken: "AT_NEW",
      expiresAt: new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
      expiresIn: 18000,
      lastRefreshAt: new Date().toISOString(),
    }));

    const out = await refreshProviderCredentials(
      "grok-cli",
      {
        connectionId: "c1",
        refreshToken: "RT_OLD",
        accessToken: "AT_OLD",
        expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      },
      { info() {}, warn() {}, debug() {} }
    );

    expect(out?.accessToken).toBe("AT_NEW");
    expect(out?.refreshToken).toBe("RT_NEW");
  });

  it("shouldRefreshCredentials prioritizes near-expiry", async () => {
    const { shouldRefreshCredentials } = await import(
      "../../open-sse/services/oauthCredentialManager.js"
    );
    const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const far = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    expect(
      shouldRefreshCredentials("grok-cli", {
        refreshToken: "rt",
        expiresAt: soon,
      })
    ).toBe(true);
    expect(
      shouldRefreshCredentials("grok-cli", {
        refreshToken: "rt",
        expiresAt: far,
      })
    ).toBe(false);
  });
});
