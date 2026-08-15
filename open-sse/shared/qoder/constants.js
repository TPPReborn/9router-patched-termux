/**
 * Qoder API constants ported from CLIProxyAPIPlus qoder-provider branch.
 *
 * Endpoint set:
 *   openapi.qoder.sh   - device flow + userinfo + quota usage
 *   center.qoder.sh    - token refresh (best-effort, currently 403 for device tokens)
 *   api2.qoder.sh      - inference (chat) + model list, requires COSY signing
 *   qoder.com/device   - browser landing page for device authorization
 */

export const QODER_OPENAPI_BASE = "https://openapi.qoder.sh";
export const QODER_CENTER_BASE = "https://center.qoder.sh";
export const QODER_CHAT_BASE = "https://api2.qoder.sh";

export const QODER_LOGIN_URL = "https://qoder.com/device/selectAccounts";

// Device-flow client id, matches qodercli 1.1.14 (pxD). Used in the
// selectAccounts URL + deviceToken/poll so the upstream identifies the client.
export const QODER_CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";

// Device flow endpoints
export const QODER_DEVICE_TOKEN_URL = `${QODER_OPENAPI_BASE}/api/v1/deviceToken/poll`;
export const QODER_USERINFO_URL = `${QODER_OPENAPI_BASE}/api/v1/userinfo`;
export const QODER_QUOTA_USAGE_URL = `${QODER_OPENAPI_BASE}/api/v2/quota/usage`;
export const QODER_REFRESH_TOKEN_URL = `${QODER_OPENAPI_BASE}/api/v1/deviceToken/refresh`;

// Inference endpoints (under /algo on api2.qoder.sh, all COSY-signed)
export const QODER_CHAT_SIG_PATH = "/api/v2/service/pro/sse/agent_chat_generation";
export const QODER_CHAT_URL = `${QODER_CHAT_BASE}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common`;
// Binary (1.1.14) sends RAW JSON body for chat — NO Encode=1 param on the
// chat URL, NO body encoding. Encode=1 is only used for model list,
// business/finish, imageSearch, generateImage (verified at byte offsets
// 100843221..103449278). Server accepts raw body when properly Cosy-signed.
export const QODER_CHAT_URL_ENCODED = QODER_CHAT_URL;
export const QODER_MODEL_LIST_URL = `${QODER_CHAT_BASE}/algo/api/v2/model/list?Encode=1`;

// COSY header constants. Matches qodercli 1.1.14 (binary at
// ~/.qoder/bin/qodercli/qodercli-1.1.14):
//   - Cosy-Version: CLI version (v9A = "1.1.14")
//   - Cosy-MachineOS: dynamic platform (aarch64_linux on this box)
//   - Cosy-ClientType: "5" (default; "6" when QODER_WORK_INTEGRATION_MODE=1)
export const QODER_IDE_VERSION = "1.1.14";
export const QODER_CLIENT_TYPE = "5";
export const QODER_DATA_POLICY = "disagree";
export const QODER_LOGIN_VERSION = "v2";
export const QODER_MACHINE_OS = "aarch64_linux";
export const QODER_MACHINE_TYPE = "5";

// Canonical model identifiers. Identity map — keep as a map so callers can
// cheaply test "is this a known qoder model?" before sending the request.
export const QODER_MODEL_MAP = {
  // Tier models
  auto: "auto",
  ultimate: "ultimate",
  performance: "performance",
  efficient: "efficient",
  lite: "lite",
  // Frontier models
  qmodel: "qmodel",
  qmodel_latest: "qmodel_latest",
  qmodel_38max: "qmodel_38max", // Qwen3.8-Max (Cantus)
  kmodel_latest: "kmodel_latest",
  dmodel: "dmodel",
  dfmodel: "dfmodel",
  gm51model: "gm51model",
  kmodel: "kmodel",
  mmodel: "mmodel",
};

// RSA public key for COSY encryption (extracted from Qoder IDE v0.9).
// Matches the CLIProxyAPIPlus branch and live qodercli traffic.
export const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
