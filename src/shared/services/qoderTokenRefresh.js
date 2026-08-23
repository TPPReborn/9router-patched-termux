// DEPRECATED — token refresh now integrated into oauthTokenWarm.js
// See oauthTokenWarm.js for current implementation with per-tick scheduling
// This file remains for backwards compatibility only.

export function startQoderTokenRefresh() {
  console.warn("[QoderRefresh] DEPRECATED: use oauthTokenWarm.js instead");
}

export function stopQoderTokenRefresh() {
  console.warn("[QoderRefresh] DEPRECATED");
}

export async function runQoderTokenRefreshTick() {
  console.warn("[QoderRefresh] DEPRECATED");
  return {};
}
