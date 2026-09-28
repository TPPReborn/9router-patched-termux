// Aligned with official grok CLI binary 0.2.106 (bde89716f6) on this host.
export const GROK_CLI_VERSION = "0.2.120";
// Default selectable model for 9router accounts (virtual effort suffix → upstream grok-4.5).
export const GROK_CLI_MODEL = "grok-4.5-xhigh";
export const GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";
export const GROK_CLI_TOKEN_AUTH = "xai-grok-cli";
export const GROK_CLI_CLIENT_MODE = "headless";
// Binary device-code path stamps surface=grok-build (not client-mode).
export const GROK_CLI_CLIENT_SURFACE = "grok-build";
export const GROK_CLI_REFERRER = "grok-build";

// UA mirrors grok-shell/<ver> (<os>; <arch>).
// Static values for browser bundling compatibility - actual platform detection
// happens server-side during request execution where it matters.
export const GROK_CLI_USER_AGENT =
  `grok-shell/${GROK_CLI_VERSION} (linux; aarch64)`;

/**
 * User principal device-code scopes (binary default pack + OIDC core).
 * Never include team:read — auth.x.ai rejects it for User principals.
 */
export const GROK_CLI_USER_DEVICE_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read";

export function supportsGrokCliReasoningEffort(model) {
  // ponytail: unknown models omit effort until live metadata reaches dispatch.
  // Binary: reasoning_effort levels low|medium|high|xhigh for grok-4.5 family.
  return /^grok-4\.5(?:$|-)/.test(String(model || ""));
}

/** Best-effort JWT payload decode (no verify) — used to surface bot_flag_source. */
export function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
