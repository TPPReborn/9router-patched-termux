import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Spy-able wrapper around the real localDb so a delete failure can be simulated
// (fail-safe path) without touching the DB layer.
vi.mock("@/lib/localDb", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, deleteProviderConnection: vi.fn(actual.deleteProviderConnection) };
});

// Zero-balance hard-delete policy for purchased account pools (BAI node).
// Upstream 400 "credit insufficient balance: balance=0 …" must DELETE the
// account row instead of only disabling it — such accounts never recover.
const BAI_PROVIDER = "openai-compatible-chat-65f09875-1a72-44bc-8d53-0e2fdb865d9a";
const OTHER_PROVIDER = "openai-compatible-chat-testnode";

const ZERO_BALANCE_400 =
  '[400]: {"error":{"message":"credit insufficient balance: balance=0 required=4902 (request id: 20260923174249181441275c955d568gWT3oVUW)","type":"api_error","param":"","code":"insufficient_user_quota"}}';
const PREMIUM_GATE_403 =
  '[403]: {"error":{"code":"access_denied","message":"Access restricted. Deposit required to unlock premium model"}}';

async function mkAccount(provider, name, priority) {
  const { createProviderConnection } = await import("@/lib/db/index.js");
  return createProviderConnection({
    provider,
    authType: "apikey",
    name,
    priority,
    apiKey: "test-key",
    testStatus: "active",
  });
}

describe("zero-balance hard-delete policy (BAI node)", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-zerobal-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("deletes the account row on 400 insufficient-balance balance=0", async () => {
    const { getProviderConnections } = await import("@/lib/db/index.js");
    const { markAccountUnavailable } = await import("@/sse/services/auth.js");

    const acct = await mkAccount(BAI_PROVIDER, "dead-zero-balance", 1);
    const res = await markAccountUnavailable(acct.id, 400, ZERO_BALANCE_400, BAI_PROVIDER, "m");

    expect(res.shouldFallback).toBe(true);
    expect(res.deleted).toBe(true);

    const rows = await getProviderConnections({ provider: BAI_PROVIDER });
    expect(rows.some((c) => c.id === acct.id)).toBe(false); // gone, not merely disabled
  });

  it("does not leak the delete to other providers (they keep the disable path)", async () => {
    const { getProviderConnections } = await import("@/lib/db/index.js");
    const { markAccountUnavailable } = await import("@/sse/services/auth.js");

    const acct = await mkAccount(OTHER_PROVIDER, "zero-balance-other", 1);
    const res = await markAccountUnavailable(acct.id, 400, ZERO_BALANCE_400, OTHER_PROVIDER, "m");

    expect(res.shouldFallback).toBe(true);
    expect(res.deleted).toBeFalsy();
    expect(res.disabled).toBe(true);

    const row = (await getProviderConnections({ provider: OTHER_PROVIDER })).find((c) => c.id === acct.id);
    expect(row).toBeTruthy();
    expect(row.isActive).toBe(false);
  });

  it("premium-gate 403 stays skip-only — never deleted", async () => {
    const { getProviderConnections } = await import("@/lib/db/index.js");
    const { markAccountUnavailable } = await import("@/sse/services/auth.js");

    const acct = await mkAccount(BAI_PROVIDER, "gated", 1);
    const res = await markAccountUnavailable(acct.id, 403, PREMIUM_GATE_403, BAI_PROVIDER, "premium-model");

    expect(res.skipOnly).toBe(true);
    expect(res.deleted).toBeFalsy();

    const row = (await getProviderConnections({ provider: BAI_PROVIDER })).find((c) => c.id === acct.id);
    expect(row).toBeTruthy();
    expect(row.isActive).toBe(true);
  });

  it("content-length 400 stays skip-only — never deleted", async () => {
    const { getProviderConnections } = await import("@/lib/db/index.js");
    const { markAccountUnavailable } = await import("@/sse/services/auth.js");

    const acct = await mkAccount(BAI_PROVIDER, "content-too-long", 1);
    const res = await markAccountUnavailable(
      acct.id,
      400,
      "maximum prompt length is 500000 but the request contains 600000",
      BAI_PROVIDER,
      "m",
    );

    expect(res.deleted).toBeFalsy();
    const row = (await getProviderConnections({ provider: BAI_PROVIDER })).find((c) => c.id === acct.id);
    expect(row).toBeTruthy();
  });

  it("balance=0.5 does NOT match the strict zero — disable path, never deleted", async () => {
    const { getProviderConnections } = await import("@/lib/db/index.js");
    const { markAccountUnavailable } = await import("@/sse/services/auth.js");

    const acct = await mkAccount(BAI_PROVIDER, "near-zero", 1);
    const res = await markAccountUnavailable(
      acct.id,
      400,
      '[400]: {"error":{"message":"credit insufficient balance: balance=0.5 required=100"}}',
      BAI_PROVIDER,
      "m",
    );

    expect(res.deleted).toBeFalsy();
    const row = (await getProviderConnections({ provider: BAI_PROVIDER })).find((c) => c.id === acct.id);
    expect(row).toBeTruthy();
    expect(row.isActive).toBe(false); // disabled, not deleted
  });

  it("delete failure falls back to the disable path (row stays, isActive=false)", async () => {
    const localDb = await import("@/lib/localDb");
    const { getProviderConnections } = await import("@/lib/db/index.js");
    const { markAccountUnavailable } = await import("@/sse/services/auth.js");

    const acct = await mkAccount(BAI_PROVIDER, "delete-throws", 1);
    localDb.deleteProviderConnection.mockRejectedValueOnce(new Error("simulated db failure"));

    const res = await markAccountUnavailable(acct.id, 400, ZERO_BALANCE_400, BAI_PROVIDER, "m");

    expect(res.shouldFallback).toBe(true);
    expect(res.deleted).toBeFalsy();
    const row = (await getProviderConnections({ provider: BAI_PROVIDER })).find((c) => c.id === acct.id);
    expect(row).toBeTruthy();
    expect(row.isActive).toBe(false);
  });
});
