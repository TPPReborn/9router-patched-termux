import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// End-to-end on a temp DB: upstream answers 400 with an insufficient-balance body →
// account must be isActive=false and dropped from selection (so chat.js falls back).
describe("markAccountUnavailable auto-disable (temp DB)", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-autodisable-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("disables on 403 and on 400 insufficient-balance, keeps content errors alive", async () => {
    const { createProviderConnection, getProviderConnections } = await import("@/lib/db/index.js");
    const { markAccountUnavailable, getProviderCredentials } = await import("@/sse/services/auth.js");

    const provider = "openai-compatible-chat-testnode";
    const mk = (name, priority) =>
      createProviderConnection({
        provider,
        authType: "apikey",
        name,
        priority,
        apiKey: "sk-test",
        testStatus: "active",
      });

    const dead = await mk("dead-by-403", 1);
    const broke = await mk("broke-by-400-body", 2);
    const healthy = await mk("healthy", 3);

    // 403 → disable
    const r403 = await markAccountUnavailable(dead.id, 403, "permission denied", provider, "m");
    expect(r403.disabled).toBe(true);
    expect((await getProviderConnections({ provider })).find((c) => c.id === dead.id).isActive).toBe(false);

    // 400 with insufficient-balance body → disable (was only a 30s lock before)
    const bai =
      '[400]: {"error":{"message":"credit insufficient balance: balance=0 required=4560 (request id: abc)"}}';
    const r400 = await markAccountUnavailable(broke.id, 400, bai, provider, "m");
    expect(r400.disabled).toBe(true);
    expect((await getProviderConnections({ provider })).find((c) => c.id === broke.id).isActive).toBe(false);

    // Only the healthy account is offered to rotation now
    const picked = await getProviderCredentials(provider, null, "m");
    expect(picked.connectionId).toBe(healthy.id);

    // Content-length 400 stays skip-only: still active for the next request
    const rContent = await markAccountUnavailable(healthy.id, 400, "maximum prompt length is 500000", provider, "m");
    expect(rContent.disabled).toBe(false);
    expect((await getProviderConnections({ provider })).find((c) => c.id === healthy.id).isActive).toBe(true);
  });

  it("403 per-model paywall does NOT disable — account stays in the pool", async () => {
    const { createProviderConnection, getProviderConnections } = await import("@/lib/db/index.js");
    const { markAccountUnavailable, getProviderCredentials } = await import("@/sse/services/auth.js");

    const provider = "openai-compatible-chat-gatetest";
    const acct = await createProviderConnection({
      provider,
      authType: "apikey",
      name: "gated",
      priority: 1,
      apiKey: "sk-test",
      testStatus: "active",
    });

    const gate =
      '[403]: {"error":{"code":"access_denied","message":"Access restricted. Deposit required to unlock premium model"}}';
    const res = await markAccountUnavailable(acct.id, 403, gate, provider, "premium-model");
    expect(res.disabled).toBe(false);
    expect(res.skipOnly).toBe(true);

    const stored = (await getProviderConnections({ provider })).find((c) => c.id === acct.id);
    expect(stored.isActive).toBe(true);
    expect(stored.testStatus).toBe("unavailable");
    expect(stored[`modelLock_premium-model`]).toBeTruthy();

    // Another model on the same account is still selectable (lock is per model).
    const picked = await getProviderCredentials(provider, null, "other-model");
    expect(picked.connectionId).toBe(acct.id);
  });
});
