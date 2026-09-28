/**
 * Grok CLI / Grok Build (cli-chat-proxy.grok.com)
 *
 * Source of truth: official grok binary 0.2.106 (bde89716f6) installed at
 * ~/.grok/bin/grok — strings + embedded docs for auth/headers/endpoints.
 * Wire format: OpenAI Responses API (force stream).
 *
 * Distinct from:
 *  - `xai`      → api.x.ai (API key / xAI API OAuth PKCE)
 *  - `grok-web` → grok.com web SSO cookie
 */
import {
  GROK_CLI_BASE_URL,
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_CLIENT_MODE,
  GROK_CLI_MODEL,
  GROK_CLI_REFERRER,
  GROK_CLI_TOKEN_AUTH,
  GROK_CLI_USER_AGENT,
  GROK_CLI_USER_DEVICE_SCOPE,
  GROK_CLI_VERSION,
} from "../../config/grokCli.js";

export default {
  id: "grok-cli",
  priority: 275,
  alias: "gcli",
  aliases: ["grok-build", "gb"],
  uiAlias: "gcli",
  display: {
    name: "Grok CLI (Grok Build)",
    icon: "auto_awesome",
    color: "#1DA1F2",
    textIcon: "GC",
    website: "https://x.ai",
    notice: {
      text: "Sign in with your xAI / Grok account via device code. Uses Grok Build subscription credits (cli-chat-proxy.grok.com).",
      signupUrl: "https://grok.com/supergrok?referrer=grok-build",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  thinkingConfig: {
    // Binary: low | medium | high | xhigh (max → xhigh)
    options: ["low", "medium", "high", "xhigh"],
    defaultMode: "xhigh",
  },
  transport: {
    baseUrl: `${GROK_CLI_BASE_URL}/responses`,
    format: "openai-responses",
    // Binary docs: most proxy models only support streaming
    forceStream: true,
    modelsUrl: `${GROK_CLI_BASE_URL}/models`,
    userUrl: `${GROK_CLI_BASE_URL}/user`,
    billingUrl: `${GROK_CLI_BASE_URL}/billing`,
    clientVersion: GROK_CLI_VERSION,
    clientIdentifier: GROK_CLI_CLIENT_IDENTIFIER,
    tokenAuth: GROK_CLI_TOKEN_AUTH,
    headers: {
      "User-Agent": GROK_CLI_USER_AGENT,
      // Required by auth middleware (binary README curl table)
      "X-XAI-Token-Auth": GROK_CLI_TOKEN_AUTH,
      "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
      "x-grok-client-version": GROK_CLI_VERSION,
      // Server-side gateway acts as headless CLI client
      "x-grok-client-mode": GROK_CLI_CLIENT_MODE,
    },
    // Quota tracker: official CLI polls billing?format=credits + user?include=subscription
    usage: {
      url: `${GROK_CLI_BASE_URL}/billing?format=credits`,
      userUrl: `${GROK_CLI_BASE_URL}/user?include=subscription`,
    },
    retry: {
      429: { attempts: 2, delayMs: 2000 },
      502: { attempts: 2, delayMs: 1500 },
      503: { attempts: 2, delayMs: 1500 },
    },
  },
  models: [
    // Default first: virtual effort model → upstream grok-4.5 + reasoning.effort=xhigh
    {
      id: GROK_CLI_MODEL,
      name: "Grok 4.5 (xHigh)",
      upstreamModelId: "grok-4.5",
    },
    {
      id: "grok-build",
      name: "Grok Build",
      contextLength: 500000,
      maxOutputTokens: 64000,
    },
    { id: "grok-4.5", name: "Grok 4.5" },
    { id: "grok-4.5-high", name: "Grok 4.5 (High)", upstreamModelId: "grok-4.5" },
    { id: "grok-4.5-medium", name: "Grok 4.5 (Medium)", upstreamModelId: "grok-4.5" },
    { id: "grok-4.5-low", name: "Grok 4.5 (Low)", upstreamModelId: "grok-4.5" },
  ],
  features: {
    usage: true,
  },
  oauth: {
    // Same public client_id as Grok CLI / existing xai OAuth
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    refreshUrl: "https://auth.x.ai/oauth2/token",
    // User device-code scopes — single source GROK_CLI_USER_DEVICE_SCOPE
    // (no team:read; auth.x.ai rejects it for User principals).
    scope: GROK_CLI_USER_DEVICE_SCOPE,
    referrer: GROK_CLI_REFERRER,
    // Binary early-invalidation default is 300s, but multi-account pools need a
    // wider warm window so OAuthWarm / request-path refresh rotate before the
    // selected account hits a cold 401 mid-stream. 30m matches the prior
    // invalid_grant race fix (refreshLead 5m→30m).
    refreshLeadMs: 30 * 60 * 1000,
  },
};
