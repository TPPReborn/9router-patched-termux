import { register } from "node:module";
import { pathToFileURL } from "node:url";

const root = "/data/data/com.termux/files/home/9router";
process.chdir(root);
process.env.DATA_DIR ||= "/data/data/com.termux/files/usr/var/lib/9router";
register(pathToFileURL(root + "/tmp-alias-loader.mjs").href);

const {
  getProviderConnections,
  getProviderConnectionById,
  updateProviderConnection,
  rotateOAuthTokensIfMatch,
} = await import(pathToFileURL(root + "/src/lib/db/index.js").href);
const {
  setConnectionLoader,
  refreshProviderCredentials,
} = await import(pathToFileURL(root + "/open-sse/services/oauthCredentialManager.js").href);
const { withRefreshGate, isSingleUseRefreshProvider } = await import(
  pathToFileURL(root + "/src/lib/oauth/refreshGate.js").href
);

// Force network path: loader returns expired expiresAt so under-gate re-adopt still refreshes.
setConnectionLoader(async (id) => {
  try {
    const row = await getProviderConnectionById(id);
    if (!row) return null;
    return {
      ...row,
      connectionId: id,
      expiresAt: new Date(Date.now() - 120_000).toISOString(),
    };
  } catch {
    return null;
  }
});

const log = {
  info: (tag, msg, extra) => console.log(JSON.stringify({ level: "info", tag, msg, ...(extra || {}) })),
  warn: (tag, msg, extra) => console.log(JSON.stringify({ level: "warn", tag, msg, ...(extra || {}) })),
  debug: () => {},
  error: (tag, msg, extra) => console.log(JSON.stringify({ level: "error", tag, msg, ...(extra || {}) })),
};

const connections = await getProviderConnections({ provider: "grok-cli" });
console.log(JSON.stringify({ phase: "start", total: connections.length }));

const concurrency = 2;
let idx = 0;
const stats = { ok: 0, fail: 0, skipped: 0, refreshed: 0, same: 0 };

function toExpiresAt(expiresIn) {
  if (expiresIn == null) return null;
  return new Date(Date.now() + Number(expiresIn) * 1000).toISOString();
}

async function persist(connectionId, usedRt, newCreds, prev) {
  const expiresAt =
    newCreds.expiresIn != null
      ? toExpiresAt(newCreds.expiresIn)
      : newCreds.expiresAt || prev.expiresAt || null;
  const patch = {
    accessToken: newCreds.accessToken,
    refreshToken: newCreds.refreshToken || usedRt,
    expiresAt,
    expiresIn: newCreds.expiresIn ?? prev.expiresIn ?? null,
    lastRefreshAt: new Date().toISOString(),
    idToken: newCreds.idToken ?? prev.idToken ?? null,
  };
  if (newCreds.providerSpecificData) {
    patch.providerSpecificData = {
      ...(prev.providerSpecificData || {}),
      ...newCreds.providerSpecificData,
    };
  }
  if (usedRt && isSingleUseRefreshProvider("grok-cli")) {
    const cas = await rotateOAuthTokensIfMatch(connectionId, usedRt, patch);
    if (!cas.ok && cas.reason === "rt_mismatch") {
      return { reason: "rt_mismatch_adopted", connection: cas.connection };
    }
    if (!cas.ok) {
      await updateProviderConnection(connectionId, patch);
      return { reason: "cas_fallback_update" };
    }
    return { reason: "cas_ok", connection: cas.connection };
  }
  await updateProviderConnection(connectionId, patch);
  return { reason: "update" };
}

async function one(c) {
  const id = c.id;
  const email = c.email || c.name || id;
  if (!c.refreshToken) {
    stats.skipped += 1;
    console.log(JSON.stringify({ id, email, status: "skip_no_rt" }));
    return;
  }
  const beforeAt = (c.accessToken || "").slice(-16);
  const beforeExp = c.expiresAt;
  const usedRt = c.refreshToken;
  const creds = {
    ...c,
    id,
    connectionId: id,
    expiresAt: new Date(Date.now() - 120_000).toISOString(),
  };

  try {
    const run = async () => refreshProviderCredentials("grok-cli", creds, log);
    let newCreds;
    if (isSingleUseRefreshProvider("grok-cli")) {
      const gate = await withRefreshGate(id, run);
      if (!gate.acquired) {
        await new Promise((r) => setTimeout(r, 1500));
        const latest = await getProviderConnectionById(id);
        const afterAt = (latest?.accessToken || "").slice(-16);
        const rotated = !!(beforeAt && afterAt && beforeAt !== afterAt);
        if (rotated) {
          stats.ok += 1;
          stats.refreshed += 1;
          console.log(JSON.stringify({ id, email, status: "refreshed_by_other", beforeExp, afterExp: latest?.expiresAt, rotated: true }));
        } else {
          stats.fail += 1;
          console.log(JSON.stringify({ id, email, status: "gate_busy", beforeExp, afterExp: latest?.expiresAt }));
        }
        return;
      }
      newCreds = gate.result;
    } else {
      newCreds = await run();
    }

    if (!newCreds?.accessToken) {
      stats.fail += 1;
      console.log(JSON.stringify({ id, email, status: "fail_no_access", error: newCreds?.error || null }));
      return;
    }

    const saved = await persist(id, usedRt, newCreds, c);
    const finalRow = await getProviderConnectionById(id);
    const finalAt = (finalRow?.accessToken || "").slice(-16);
    const rotated = !!(beforeAt && finalAt && beforeAt !== finalAt) ||
      !!(newCreds.refreshToken && newCreds.refreshToken !== usedRt);
    stats.ok += 1;
    if (rotated) stats.refreshed += 1;
    else stats.same += 1;
    console.log(JSON.stringify({
      id,
      email,
      status: rotated ? "refreshed" : "ok_same",
      beforeExp,
      afterExp: finalRow?.expiresAt || null,
      rotated,
      persist: saved.reason,
    }));
  } catch (e) {
    stats.fail += 1;
    console.log(JSON.stringify({ id, email, status: "error", error: String(e?.message || e) }));
  }
}

const items = connections.slice();
const workers = Array.from({ length: concurrency }, async () => {
  while (true) {
    const i = idx++;
    if (i >= items.length) break;
    await one(items[i]);
    await new Promise((r) => setTimeout(r, 250));
  }
});
await Promise.all(workers);
console.log(JSON.stringify({
  phase: "done",
  summary: {
    ok: stats.ok,
    fail: stats.fail,
    skipped: stats.skipped,
    refreshed: stats.refreshed,
    same: stats.same,
  },
}));
process.exit(stats.fail ? 2 : 0);
