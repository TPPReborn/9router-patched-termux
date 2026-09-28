// Aligned with official grok CLI binary 0.2.106 (bde89716f6) on this host.
export const GROK_CLI_VERSION = "0.2.106";
// Default selectable model for 9router accounts (virtual effort suffix → upstream grok-4.5).
export const GROK_CLI_MODEL = "grok-4.5-xhigh";
export const GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";
export const GROK_CLI_TOKEN_AUTH = "xai-grok-cli";
export const GROK_CLI_CLIENT_MODE = "headless";
export const GROK_CLI_USER_AGENT = `grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`;

export function supportsGrokCliReasoningEffort(model) {
  // ponytail: unknown models omit effort until live metadata reaches dispatch.
  // Binary: reasoning_effort levels low|medium|high|xhigh for grok-4.5 family.
  return /^grok-4\.5(?:$|-)/.test(String(model || ""));
}
