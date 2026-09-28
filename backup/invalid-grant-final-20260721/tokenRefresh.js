// Re-export from open-sse with local logger
import * as log from "../utils/logger.js";
import {
  updateProviderConnection,
  getProviderConnectionById,
  rotateOAuthTokensIfMatch,
} from "../../lib/localDb.js";
import {
  withRefreshGate,
  isSingleUseRefreshProvider,
} from "../../lib/oauth/refreshGate.js";
import {
  getProjectIdForConnection,
  invalidateProjectId,
  removeConnection,
} from "open-sse/services/projectId.js";
import {
  TOKEN_EXPIRY_BUFFER_MS as BUFFER_MS,
  refreshAccessToken as _refreshAccessToken,
  refreshClaudeOAuthToken as _refreshClaudeOAuthToken,
  refreshGoogleToken as _refreshGoogleToken,
  refreshQwenToken as _refreshQwenToken,
  refreshCodexToken as _refreshCodexToken,
  refreshIflowToken as _refreshIflowToken,
  refreshGitHubToken as _refreshGitHubToken,
  refreshCopilotToken as _refreshCopilotToken,
  getAccessToken as _getAccessToken,
  refreshTokenByProvider as _refreshTokenByProvider,
  formatProviderCredentials as _formatProviderCredentials,
  getAllAccessTokens as _getAllAccessTokens,
  refreshKiroToken as _refreshKiroToken,
  getRefreshLeadMs as _getRefreshLeadMs,
  isUnrecoverableRefreshError as _isUnrecoverableRefreshError,
} from "open-sse/services/tokenRefresh.js";
import {
  refreshProviderCredentials as _refreshProviderCredentials,
  shouldRefreshCredentials as _shouldRefreshCredentials,
} from "open-sse/services/oauthCredentialManager.js";

export const TOKEN_EXPIRY_BUFFER_MS = BUFFER_MS;

// ─── Re-exports wrapped with local logger ─────────────────────────────────────

export const refreshAccessToken = (provider, refreshToken, credentials) =>
  _refreshAccessToken(provider, refreshToken, credentials, log);

export const refreshClaudeOAuthToken = (refreshToken) =>
  _refreshClaudeOAuthToken(refreshToken, log);

export const refreshGoogleToken = (refreshToken, clientId, clientSecret) =>
  _refreshGoogleToken(refreshToken, clientId, clientSecret, log);

export const refreshQwenToken = (refreshToken) =>
  _refreshQwenToken(refreshToken, log);

export const refreshCodexToken = (refreshToken) =>
  _refreshCodexToken(refreshToken, log);

export const refreshIflowToken = (refreshToken) =>
  _refreshIflowToken(refreshToken, log);

export const refreshGitHubToken = (refreshToken) =>
  _refreshGitHubToken(refreshToken, log);

export const refreshCopilotToken = (githubAccessToken) =>
  _refreshCopilotToken(githubAccessToken, log);

export const refreshKiroToken = (refreshToken, providerSpecificData) =>
  _refreshKiroToken(refreshToken, providerSpecificData, log);

export const getAccessToken = (provider, credentials) =>
  _getAccessToken(provider, credentials, log);

export const refreshTokenByProvider = (provider, credentials) =>
  _refreshTokenByProvider(provider, credentials, log);

export const formatProviderCredentials = (provider, credentials) =>
  _formatProviderCredentials(provider, credentials, log);

export const getAllAccessTokens = (userInfo) =>
  _getAllAccessTokens(userInfo, log);

export const shouldRefreshCredentials = (provider, credentials) =>
  _shouldRefreshCredentials(provider, credentials);

export const isUnrecoverableRefreshError = (result) =>
  _isUnrecoverableRefreshError(result);

// ─── Lifecycle hook ───────────────────────────────────────────────────────────

/**
 * Call this when a connection is fully closed / removed.
 * Aborts any in-flight projectId fetch and evicts its cache entry,
 * preventing the module-level Maps from accumulating stale entries.
 *
 * @param {string} connectionId
 */
export function releaseConnection(connectionId) {
  if (!connectionId) return;
  removeConnection(connectionId);
  log.debug("TOKEN_REFRESH", "Released connection resources", { connectionId });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute an ISO expiry timestamp from a relative expiresIn (seconds).
 * @param {number} expiresIn
 * @returns {string}
 */
function toExpiresAt(expiresIn) {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Providers that carry a real Google project ID.
 * @param {string} provider
 * @returns {boolean}
 */
function needsProjectId(provider) {
  return provider === "antigravity" || provider === "gemini-cli";
}

/**
 * Non-blocking: fetch the project ID for a connection after a token refresh and
 * persist it to localDb.  Invalidates the stale cached value first so the fetch
 * always retrieves a fresh one.
 *
 * @param {string} provider
 * @param {string} connectionId
 * @param {string} accessToken
 */
function _refreshProjectId(provider, connectionId, accessToken) {
  if (!needsProjectId(provider) || !connectionId || !accessToken) return;

  // Evict the stale cached entry so getProjectIdForConnection does a real fetch
  invalidateProjectId(connectionId);

  getProjectIdForConnection(connectionId, accessToken)
    .then((projectId) => {
      if (!projectId) return;
      updateProviderCredentials(connectionId, { projectId }).catch((err) => {
        log.debug("TOKEN_REFRESH", "Failed to persist refreshed projectId", {
          connectionId,
          error: err?.message ?? err,
        });
      });
    })
    .catch((err) => {
      log.debug("TOKEN_REFRESH", "Failed to fetch projectId after token refresh", {
        connectionId,
        error: err?.message ?? err,
      });
    });
}

// ─── Local-specific: persist credentials to localDb ──────────────────────────

/**
 * Persist updated credentials for a connection to localDb.
 * Only fields that are present in `newCredentials` are written.
 *
 * @param {string} connectionId
 * @param {object} newCredentials
 * @returns {Promise<boolean>}
 */
export async function updateProviderCredentials(connectionId, newCredentials) {
  try {
    const updates = {};

    if (newCredentials.accessToken)         updates.accessToken  = newCredentials.accessToken;
    if (newCredentials.refreshToken)        updates.refreshToken = newCredentials.refreshToken;
    if (newCredentials.idToken)             updates.idToken = newCredentials.idToken;
    if (newCredentials.lastRefreshAt)       updates.lastRefreshAt = newCredentials.lastRefreshAt;
    if (newCredentials.expiresAt)           updates.expiresAt = newCredentials.expiresAt;
    if (newCredentials.expiresIn) {
      updates.expiresAt = toExpiresAt(newCredentials.expiresIn);
      updates.expiresIn = newCredentials.expiresIn;
    } else if (newCredentials.expiresAt) {
      const expiresAt = normalizeExpiresAt(newCredentials.expiresAt);
      if (expiresAt) {
        updates.expiresAt = expiresAt;
        updates.expiresIn = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      }
    }
    if (newCredentials.providerSpecificData) {
      updates.providerSpecificData = {
        ...(newCredentials.existingProviderSpecificData || {}),
        ...newCredentials.providerSpecificData,
      };
    }
    if (newCredentials.copilotToken || newCredentials.copilotTokenExpiresAt) {
      updates.providerSpecificData = {
        ...(updates.providerSpecificData || newCredentials.existingProviderSpecificData || {}),
        ...(newCredentials.copilotToken ? { copilotToken: newCredentials.copilotToken } : {}),
        ...(newCredentials.copilotTokenExpiresAt ? { copilotTokenExpiresAt: newCredentials.copilotTokenExpiresAt } : {}),
      };
    }
    if (newCredentials.projectId)            updates.projectId = newCredentials.projectId;
    if (newCredentials.testStatus)           updates.testStatus = newCredentials.testStatus;
    if (newCredentials.lastError !== undefined) updates.lastError = newCredentials.lastError;
    if (newCredentials.lastErrorAt !== undefined) updates.lastErrorAt = newCredentials.lastErrorAt;

    // Single-use RT: CAS write when caller knows the RT it consumed.
    const expectedRt = newCredentials.expectedRefreshToken;
    if (expectedRt && (updates.refreshToken || updates.accessToken)) {
      const cas = await rotateOAuthTokensIfMatch(connectionId, expectedRt, updates);
      if (!cas.ok && cas.reason === "rt_mismatch") {
        log.info("TOKEN_REFRESH", "CAS skip — RT already rotated by another writer", {
          connectionId,
        });
        return true;
      }
      log.info("TOKEN_REFRESH", "Credentials CAS-updated in localDb", {
        connectionId,
        success: cas.ok,
        reason: cas.reason,
      });
      return cas.ok;
    }

    const result = await updateProviderConnection(connectionId, updates);
    log.info("TOKEN_REFRESH", "Credentials updated in localDb", {
      connectionId,
      success: !!result
    });
    return !!result;
  } catch (error) {
    log.error("TOKEN_REFRESH", "Error updating credentials in localDb", {
      connectionId,
      error: error.message,
    });
    return false;
  }
}

// ─── Local-specific: proactive token refresh ─────────────────────────────────

/**
 * Re-read connection from DB so concurrent refresh (cron / warm / other request)
 * that already rotated a single-use refresh token is not fought with a stale RT.
 * Returns null if connection missing/inactive.
 */
async function loadFreshConnectionCreds(creds) {
  if (!creds?.connectionId) return creds;
  try {
    const row = await getProviderConnectionById(creds.connectionId);
    if (!row) return null;
    if (row.isActive === false) return null;
    return {
      ...creds,
      ...row,
      connectionId: creds.connectionId || row.id,
      // Prefer DB token fields (source of truth after rotation).
      accessToken: row.accessToken ?? creds.accessToken,
      refreshToken: row.refreshToken ?? creds.refreshToken,
      expiresAt: row.expiresAt ?? creds.expiresAt,
      expiresIn: row.expiresIn ?? creds.expiresIn,
      lastRefreshAt: row.lastRefreshAt ?? creds.lastRefreshAt,
      idToken: row.idToken ?? creds.idToken,
      providerSpecificData: row.providerSpecificData ?? creds.providerSpecificData,
    };
  } catch {
    return creds;
  }
}

/**
 * On invalid_grant: another process may have already rotated the single-use RT.
 * If DB now has a different RT or a still-fresh access token, adopt it — do NOT deactivate.
 */
async function resolveUnrecoverableRefresh(provider, creds, usedRefreshToken, errorLabel) {
  if (!creds?.connectionId) {
    return { ...creds, accessToken: null, refreshToken: null, unrecoverable: true };
  }

  let latest = null;
  try {
    latest = await getProviderConnectionById(creds.connectionId);
  } catch {
    latest = null;
  }

  if (latest) {
    const rtChanged =
      latest.refreshToken &&
      usedRefreshToken &&
      latest.refreshToken !== usedRefreshToken;
    const stillFresh = !_shouldRefreshCredentials(provider, {
      ...latest,
      connectionId: latest.id,
    });

    if (rtChanged || stillFresh) {
      log.info("TOKEN_REFRESH", "Stale invalid_grant — another refresh won the race", {
        provider,
        connectionId: creds.connectionId,
        rtChanged: !!rtChanged,
        stillFresh: !!stillFresh,
      });
      return {
        ...creds,
        ...latest,
        connectionId: creds.connectionId,
        accessToken: latest.accessToken,
        refreshToken: latest.refreshToken,
        expiresAt: latest.expiresAt,
        expiresIn: latest.expiresIn,
        lastRefreshAt: latest.lastRefreshAt,
        idToken: latest.idToken,
        providerSpecificData: latest.providerSpecificData,
        unrecoverable: false,
      };
    }
  }

  log.warn("TOKEN_REFRESH", "Unrecoverable refresh — deactivating connection", {
    provider,
    connectionId: creds.connectionId,
    error: errorLabel,
  });
  try {
    await updateProviderConnection(creds.connectionId, {
      isActive: false,
      testStatus: "error",
      lastError: `OAuth refresh failed: ${errorLabel || "invalid_grant"}`,
      lastErrorAt: new Date().toISOString(),
      errorCode: 401,
    });
  } catch (err) {
    log.debug("TOKEN_REFRESH", "Failed to deactivate connection after unrecoverable refresh", {
      connectionId: creds.connectionId,
      error: err?.message ?? err,
    });
  }
  return { ...creds, accessToken: null, refreshToken: null, unrecoverable: true };
}

/**
 * Core proactive refresh for one connection. Caller holds cross-process gate
 * when provider uses single-use refresh tokens.
 */
async function doAccessTokenRefresh(provider, creds) {
  const expiresAt = creds.expiresAt ? new Date(creds.expiresAt).getTime() : null;
  const remaining = expiresAt ? expiresAt - Date.now() : null;
  const refreshLead = _getRefreshLeadMs(provider);
  const usedRefreshToken = creds.refreshToken;

  log.info("TOKEN_REFRESH", "Refreshing provider credentials proactively", {
    provider,
    connectionId: creds.connectionId || null,
    expiresIn: remaining === null ? null : Math.round(remaining / 1000),
    refreshLeadMs: refreshLead,
    lastRefreshAt: creds.lastRefreshAt || null,
  });

  const newCreds = await _refreshProviderCredentials(provider, creds, log);
  if (_isUnrecoverableRefreshError(newCreds)) {
    // Rotated/revoked — re-check DB first (another writer may have won).
    return resolveUnrecoverableRefresh(
      provider,
      creds,
      usedRefreshToken,
      newCreds.error
    );
  }

  if (newCreds?.accessToken || newCreds?.apiKey || newCreds?.copilotToken) {
    const mergedCreds = {
      ...newCreds,
      existingProviderSpecificData: creds.providerSpecificData,
      // CAS: only write if DB still holds the RT we just consumed.
      expectedRefreshToken: usedRefreshToken,
    };

    await updateProviderCredentials(creds.connectionId, mergedCreds);

    const next = {
      ...creds,
      ...newCreds,
      expiresAt: newCreds.expiresIn
        ? toExpiresAt(newCreds.expiresIn)
        : normalizeExpiresAt(newCreds.expiresAt) || newCreds.expiresAt || creds.expiresAt,
      providerSpecificData: newCreds.providerSpecificData
        ? { ...creds.providerSpecificData, ...newCreds.providerSpecificData }
        : creds.providerSpecificData,
    };

    _refreshProjectId(provider, next.connectionId, next.accessToken);
    return next;
  }

  return creds;
}

export async function checkAndRefreshToken(provider, credentials) {
  let creds = { ...credentials };
  if (!creds.connectionId && creds.id) {
    creds.connectionId = creds.id;
  }

  // ── 0. Adopt latest RT/AT from DB (xAI single-use RT race) ────────────────
  if (creds.connectionId) {
    const fresh = await loadFreshConnectionCreds(creds);
    if (!fresh) {
      // Missing or inactive — clear tokens so account-selection skips us.
      creds.accessToken = null;
      creds.refreshToken = null;
      return creds;
    }
    creds = fresh;
  }

  // ── 1. Regular access-token expiry ────────────────────────────────────────
  if (_shouldRefreshCredentials(provider, creds)) {
    const run = async () => {
      // Re-load under lock — another process may have just rotated.
      if (creds.connectionId) {
        const fresh = await loadFreshConnectionCreds(creds);
        if (!fresh) {
          return { ...creds, accessToken: null, refreshToken: null };
        }
        creds = fresh;
        if (!_shouldRefreshCredentials(provider, creds)) {
          return creds;
        }
      }
      return doAccessTokenRefresh(provider, creds);
    };

    if (isSingleUseRefreshProvider(provider) && creds.connectionId) {
      const gate = await withRefreshGate(creds.connectionId, run);
      if (!gate.acquired) {
        // Another process is refreshing — re-read DB (winner should have written).
        log.info("TOKEN_REFRESH", "Refresh gate busy — adopting DB state", {
          provider,
          connectionId: creds.connectionId,
          reason: gate.reason,
        });
        const latest = await loadFreshConnectionCreds(creds);
        if (latest) return latest;
        return creds;
      }
      return gate.result ?? creds;
    }

    creds = await run();
  }

  // ── 2. GitHub Copilot token expiry ────────────────────────────────────────
  if (provider === "github") {
    const copilotToken = creds.providerSpecificData?.copilotToken;
    const copilotExpiresAt = creds.providerSpecificData?.copilotTokenExpiresAt
      ? creds.providerSpecificData.copilotTokenExpiresAt * 1000
      : 0;
    const now              = Date.now();
    const remaining        = copilotExpiresAt - now;

    if (!copilotToken || remaining < TOKEN_EXPIRY_BUFFER_MS) {
      log.info("TOKEN_REFRESH", "Copilot token expiring soon or missing, refreshing proactively", {
        provider,
        expiresIn: copilotToken ? Math.round(remaining / 1000) : "missing",
      });

      const copilotTokenResult = await refreshCopilotToken(creds.accessToken);
      if (copilotTokenResult) {
        const updatedSpecific = {
          ...creds.providerSpecificData,
          copilotToken:          copilotTokenResult.token,
          copilotTokenExpiresAt: copilotTokenResult.expiresAt,
        };

        await updateProviderCredentials(creds.connectionId, {
          providerSpecificData: updatedSpecific,
        });

        creds.providerSpecificData = updatedSpecific;
        creds.copilotToken = copilotTokenResult.token;
      }
    }
  }

  return creds;
}

// ─── Local-specific: combined GitHub + Copilot refresh ───────────────────────

/**
 * Refresh the GitHub OAuth token and immediately exchange it for a fresh
 * Copilot token.
 *
 * @param {object} credentials  – must contain `refreshToken`
 * @returns {Promise<object|null>} merged credentials or the raw GitHub credentials on Copilot failure
 */
export async function refreshGitHubAndCopilotTokens(credentials) {
  const newGitHubCreds = await refreshGitHubToken(credentials.refreshToken);
  if (!newGitHubCreds?.accessToken) return newGitHubCreds;

  const copilotToken = await refreshCopilotToken(newGitHubCreds.accessToken);
  if (!copilotToken) return newGitHubCreds;

  return {
    ...newGitHubCreds,
    providerSpecificData: {
      copilotToken:          copilotToken.token,
      copilotTokenExpiresAt: copilotToken.expiresAt,
    },
  };
}
