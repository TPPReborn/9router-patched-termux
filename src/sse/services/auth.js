import { getProviderConnections, validateApiKey, updateProviderConnection, deleteProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS, ACCOUNT_DEAD_STATUSES, ACCOUNT_DEAD_BODY_400_RE, PER_MODEL_GATE_RE, ZERO_BALANCE_DELETE_PROVIDER_IDS, ZERO_BALANCE_BODY_RE } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";
import { rateLimitCheck } from "open-sse/utils/rateLimiter.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

// Hard auth / credential death — never pick again until re-auth.
const AUTH_BROKEN_RE =
  /invalid_grant|invalid or revoked|token.*revoked|refresh token.*revoked|unauthorized|authentication failed|oauth refresh failed|no access token|no refresh token/i;

// Grok free-tier / subscription exhausted — account unusable for chat until window resets
// (often hours). Disable so rotation/fill-first skips immediately.
// Also covers "insufficient balance / credit" style upstreams that report HTTP 400
// with a body like {"error":{"message":"credit insufficient balance: balance=0 …"}}
// (b.ai and friends) instead of a proper 402/403 — those accounts never recover
// on retry, so they must leave the rotation pool, not just cooldown.
const ACCOUNT_EXHAUSTED_RE =
  /free-usage-exhausted|used all the included free usage|out of credits|no.?credits?\b|credit.?insufficient|insufficient.?credit|insufficient.?balance|out of balance|exceeded your current quota|need a grok subscription|payment required|insufficient.?quota|spending.?limit|subscription:free-usage-exhausted|billing_error/i;

/**
 * Request/content errors that are NOT account-health signals.
 * Must never disable the account — only skip for this request (or short model lock).
 * Example: Grok 400 "This model's maximum prompt length is 500000 but the request contains …"
 */
const SKIP_ONLY_CONTENT_RE =
  /maximum prompt length|prompt length is|context.?length|context limit|input.?length|maximum.?length.?exceeds|request too large|payload too large|token.?limit|too many tokens|message too long/i;

// Provider-specific "this account can't serve this model" — e.g. qoder's
// per-account catalog missing the requested model key ("model_config for X
// not yet known"). The account is fine for other models; only this model
// misses. Skip to the next account, never disable.
const SKIP_ONLY_MODEL_MISS_RE =
  /model_config for .* not yet known|model not (yet )?available|model not found|model doesn'?t exist|unknown model|invalid model/i;

/**
 * True when this upstream failure should only skip the account for this turn
 * (fallback to next), never isActive=false.
 *  - 400 + max-prompt / context-length style messages
 *  - 500 / 502 upstream provider-side; not credential death)
 *  - 400 + per-account model not in catalog (skip to an account that has it)
 *  - per-model entitlement gate (403 "Deposit required to unlock premium model"):
 *    account still serves other models, so only this model is skipped/locked.
 */
export function isSkipOnlyRotationError(status, errorText) {
  const code = Number(status);
  const err = String(errorText || "");
  if (code === 500 || code === 502) return true;
  if (code === 400 && SKIP_ONLY_CONTENT_RE.test(err)) return true;
  // Even if status is missing/wrapped, content-length messages are never account death.
  if (err && SKIP_ONLY_CONTENT_RE.test(err)) return true;
  // Per-account model miss — the account may serve other models fine.
  if (err && SKIP_ONLY_MODEL_MISS_RE.test(err)) return true;
  // Per-model paywall — takes precedence over the 403 status rule below.
  if (err && PER_MODEL_GATE_RE.test(err)) return true;
  return false;
}

/**
 * Permanent / hard failure — must not enter fill-first or round-robin.
 * Temporary model locks (generic rate-limit) handled via isModelLockActive.
 * Skip-only lastError/errorCode (400 max-prompt, 500/502) must NOT poison the pool.
 */
export function isAuthBrokenConnection(c) {
  if (!c) return true;
  if (c.isActive === false) return true;
  // No usable credential material left
  if (!c.accessToken && !c.refreshToken && !c.apiKey) return true;

  const code = Number(c.errorCode);
  const err = String(c.lastError || "");

  // Stale skip-only markers: ignore for pool exclusion (short modelLock still applies).
  if (isSkipOnlyRotationError(code, err)) {
    return false;
  }

  if (c.testStatus === "error") return true;
  if (ACCOUNT_DEAD_STATUSES.includes(code)) return true;
  // 400 carrying an account-fault body (billing/quota/key) — see shouldDisableOnBadResponse
  if (code === 400 && err && ACCOUNT_DEAD_BODY_400_RE.test(err)) return true;
  if (err && AUTH_BROKEN_RE.test(err)) return true;
  if (err && ACCOUNT_EXHAUSTED_RE.test(err)) return true;
  // 429 + free-usage / subscription exhausted body (stored as lastError)
  if (code === 429 && err && ACCOUNT_EXHAUSTED_RE.test(err)) return true;
  return false;
}

/** True when this upstream failure should disable the whole account (isActive=0). */
export function shouldDisableOnBadResponse(status, errorText) {
  // Content / upstream blips: never disable — only skip + short lock.
  if (isSkipOnlyRotationError(status, errorText)) return false;
  const code = Number(status);
  const err = String(errorText || "");
  // Qoder credit-drained (code 112 personalCreditsDrainedOut) is a
  // transient quota state, not credential death — credit can be topped up.
  // Skip + short cooldown instead of disabling the account permanently.
  if (code === 403 && /112|personalCreditsDrainedOut|pricingUrl/.test(err)) return false;
  // 400/402/403 = account dead. 400 additionally requires an account-fault body
  // (billing/quota/key/access); a plain 400 request fault must not disable.
  if (ACCOUNT_DEAD_STATUSES.includes(code)) {
    return code !== 400 || ACCOUNT_DEAD_BODY_400_RE.test(err);
  }
  if (code === 400 && ACCOUNT_DEAD_BODY_400_RE.test(err)) return true;
  if (AUTH_BROKEN_RE.test(err)) return true;
  if (ACCOUNT_EXHAUSTED_RE.test(err)) return true;
  // 429 free-usage-exhausted (Grok) — not a short cooldown; disable account
  if (code === 429 && ACCOUNT_EXHAUSTED_RE.test(err)) return true;
  return false;
}

/**
 * Hard-delete policy for purchased account pools (see ZERO_BALANCE_DELETE_PROVIDER_IDS).
 * When the upstream reports a strict zero balance ("credit insufficient balance:
 * balance=0 …"), the account can never recover — the row is deleted instead of
 * disabled. Scoped to listed provider nodes only; fail-safe callers keep the
 * disable path when this returns false or the delete throws.
 */
export function shouldDeleteOnBadResponse(provider, status, errorText) {
  if (!provider || !ZERO_BALANCE_DELETE_PROVIDER_IDS.has(String(provider))) return false;
  if (Number(status) !== 400) return false;
  const err = String(errorText || "");
  if (!err) return false;
  if (isSkipOnlyRotationError(status, err)) return false;
  return ZERO_BALANCE_BODY_RE.test(err);
}

// backward-compatible alias
function shouldDisableOnAuthError(status, errorText) {
  return shouldDisableOnBadResponse(status, errorText);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      // Rate-limit gate for noAuth providers (opencode/oc): if the provider
      // is in backoff cooldown from a recent 429, refuse selection so chatCore
      // rotates to a different provider instead of burning more quota.
      const limiterCheck = rateLimitCheck(providerId, {
        minGapMs: 0,
        backoff429Ms: 15_000,
        maxBackoffMs: 60_000,
      });
      if (!limiterCheck.allowed) {
        log.warn("AUTH", `${providerId} | rate-limited (backoff ${Math.round(limiterCheck.waitMs / 1000)}s) — skipping selection`);
        return {
          allRateLimited: true,
          retryAfter: Date.now() + limiterCheck.waitMs,
          retryAfterHuman: `${Math.round(limiterCheck.waitMs / 1000)}s (rate limit backoff)`,
          lastError: `Rate limit cooldown (${providerId})`,
          lastErrorCode: 429,
        };
      }

      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Drop bad accounts from rotation immediately; disable so they stay out of pool.
    // isAuthBrokenConnection treats isActive=false as broken — force-check flags only.
    const brokenStillActive = connections.filter((c) => {
      if (c.isActive === false) return false;
      return isAuthBrokenConnection({ ...c, isActive: true });
    });
    for (const c of brokenStillActive) {
      const reason =
        c.lastError ||
        (c.errorCode != null ? `[${c.errorCode}] account marked bad` : null) ||
        `Bad account (${c.testStatus || "error"})`;
      log.warn(
        "AUTH",
        `${provider} | skip+disable bad account ${c.id?.slice(0, 8)} (${String(reason).slice(0, 120)})`,
      );
      // Fire-and-forget — do not block selection on DB write
      updateProviderConnection(c.id, {
        isActive: false,
        testStatus: "error",
        lastError: reason,
        lastErrorAt: c.lastErrorAt || new Date().toISOString(),
      }).catch(() => {});
    }
    const brokenIds = new Set(brokenStillActive.map((c) => c.id));

    // Filter out model-locked, excluded, and bad/disabled connections
    const availableConnections = connections.filter((c) => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      // Treat as inactive for this pick even if disable write hasn't landed yet
      if (brokenIds.has(c.id)) return false;
      if (isAuthBrokenConnection(c)) return false;
      return true;
    });

    // Qoder: pre-flight catalog health check — SORT, don't disable.
    // Dead/revoked device tokens (upstream 403 code 105) burned the whole
    // rotation loop one account per request; but a 403 here is often
    // transient (credit top-up, machine re-bind) — permanent disable from
    // a preflight sweep destroyed valid accounts. So: live accounts first,
    // failed ones pushed to the back of THIS pick only. The chatCore loop
    // then tries live accounts first; a real failure on chat still routes
    // through markAccountUnavailable (which disables only true credential
    // death, not credit-drained — qoder code 112 is skip-only).
    if (providerId === "qoder" && availableConnections.length > 1) {
      const [healthy, sick] = [[], []];
      for (const c of availableConnections) {
        try {
          const cat = await resolveQoderModels(c, { signal: null });
          if (cat && cat.ok === false) {
            sick.push(c);
            log.warn("AUTH", `qoder | preflight sick (back of pool) ${c.id?.slice(0, 8)} [${cat.status}]`);
          } else {
            healthy.push(c);
          }
        } catch {
          // Network blip — treat as healthy so we don't starve the pool.
          healthy.push(c);
        }
      }
      availableConnections.length = 0;
      availableConnections.push(...healthy, ...sick);
    }

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach((c) => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      const broken = brokenIds.has(c.id) || isAuthBrokenConnection(c);
      if (excluded || locked || broken) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug(
          "AUTH",
          `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded " : ""}${locked ? `modelLocked(${model}) until ${lockUntil} ` : ""}${broken ? "bad/disabled" : ""}`,
        );
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  // Prefer full-ish message for free-usage-exhausted detection / UI (cap length)
  const reasonRaw =
    typeof errorText === "string"
      ? errorText
      : errorText != null
        ? JSON.stringify(errorText)
        : "Provider error";
  const reason = reasonRaw.slice(0, 500);
  const lockUpdate = buildModelLockUpdate(model, cooldownMs);
  // Bad account (auth / free-usage-exhausted / payment): disable so rotation skips forever until re-enable.
  // Skip-only (400 max-prompt, 500/502): never disable — short model lock + fallback only.
  const skipOnly = isSkipOnlyRotationError(status, reasonRaw);
  const disableAccount = !skipOnly && shouldDisableOnBadResponse(status, reasonRaw);

  // Hard-delete policy (scoped providers only, e.g. BAI purchased pool): a strict
  // zero-balance 400 removes the row entirely — these accounts never recover.
  // Fail-safe: if the delete throws, fall through to the normal disable path.
  if (!skipOnly && shouldDeleteOnBadResponse(provider, status, reasonRaw)) {
    let deleteFailed = false;
    let deleted = false;
    try {
      deleted = await deleteProviderConnection(connectionId);
    } catch (e) {
      deleteFailed = true;
      log.warn("AUTH", `deleteProviderConnection failed (${connectionId?.slice(0, 8)}): ${e?.message || e} — falling back to disable`);
    }
    if (!deleteFailed) {
      if (deleted) {
        const connNameDel = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
        log.warn("AUTH", `${connNameDel} DELETED (zero balance, provider pool) [${status}] ${reason.slice(0, 160)}`);
        if (provider && status && reason) {
          console.error(`🗑️ ${provider} [${status}]: account ${connectionId.slice(0, 8)} deleted (zero balance)`);
        }
      } else {
        // Row already absent (e.g. concurrent delete) — treat as completed.
        log.warn("AUTH", `${connectionId?.slice(0, 8)} zero-balance row already absent — nothing to delete`);
      }
      return { shouldFallback: true, cooldownMs, deleted: true, disabled: true, skipOnly: false };
    }
    // Delete failed — fall through to the normal disable path below.
  }

  // For skip-only: still record lastError briefly for the FAIL log, but keep testStatus
  // as "unavailable" (not "error") so isAuthBrokenConnection does not permanently drop us.
  // clearAccountErrorAfterSkip (chat.js) wipes lastError once we move to the next account.
  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    ...(disableAccount
      ? {
          isActive: false,
          testStatus: "error",
        }
      : {
          testStatus: "unavailable",
        }),
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel,
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  if (disableAccount) {
    log.warn("AUTH", `${connName} DISABLED (bad account) [${status}] ${reason.slice(0, 160)}`);
  } else if (skipOnly) {
    log.warn(
      "AUTH",
      `${connName} SKIP-ONLY (no disable) ${lockKey} ${Math.round(cooldownMs / 1000)}s [${status}] ${reason.slice(0, 120)}`,
    );
  } else {
    log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);
  }

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason.slice(0, 200)}`);
  }

  return { shouldFallback: true, cooldownMs, disabled: disableAccount, skipOnly };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      errorCode: null,
      backoffLevel: 0,
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * After a skip-only failure (400 max-prompt / 500 / 502) and successful fallback
 * to the next account: wipe lastError/errorCode so the previous account is not
 * shown as BAD in the dashboard and is not treated as auth-broken.
 * Keeps any still-active model lock (short cooldown) so we don't immediately
 * re-hit the same account mid-request storm.
 */
export async function clearSkipOnlyAccountError(connectionId, status, errorText) {
  if (!connectionId || connectionId === "noauth") return;
  if (!isSkipOnlyRotationError(status, errorText)) return;
  try {
    await updateProviderConnection(connectionId, {
      lastError: null,
      lastErrorAt: null,
      errorCode: null,
      // Do not force testStatus=error; keep unavailable until lock expires or
      // a later success path clears it. If currently "error" from a prior bug,
      // demote to unavailable so rotation can pick us again after lock.
      testStatus: "unavailable",
    });
    log.info(
      "AUTH",
      `cleared skip-only lastError on ${String(connectionId).slice(0, 8)} [${status}]`,
    );
  } catch (e) {
    log.debug?.("AUTH", `clearSkipOnlyAccountError failed: ${e?.message || e}`);
  }
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
