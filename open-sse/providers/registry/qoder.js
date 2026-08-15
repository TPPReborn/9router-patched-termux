export default {
  id: "qoder",
  priority: 30,
  alias: "qd",
  uiAlias: "qd",
  display: {
    name: "Qoder ⚡ Codel",
    icon: "code_blocks",
    color: "#FFD700",
    textIcon: "CODE",
    website: "https://qoder.com",
    notice: {
      signupUrl: "https://qoder.com",
      features: "✅ Thinking: max | ✅ Tools: terminal/pretools enabled | ✅ Streaming: optimized"
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "free",
  transport: {
    baseUrl: "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation",
    headers: {},
    // Timeout & retry configuration matching qodercli 1.1.14 behavior
    // Binary classifies errors: 408/429/5xx = retryable, 401/403 = auth failure (no retry)
    timeoutMs: 90000,      // Connect timeout for faster failover (from default 120s)
    stallTimeoutMs: 60000, // Stall timeout during streaming (from default 120s)
    retryOnTimeout: true,  // Enable timeout retry/failover like binary
    maxRetryAttempts: 2,   // Retry up to 2 times on timeout before failover
    usage: {
      url: "https://openapi.qoder.sh/api/v2/quota/usage",
    },
  },
  thinkingConfig: {
    options: ["off", "low", "medium", "high", "max"],
    defaultMode: "max", // Maximum reasoning effort for best quality
    extended: true      // Extended thinking mode enabled
  },
  tools: {
    terminal: {
      enabled: true,
      autoInvoke: false, // User invokes manually to avoid unwanted commands
      maxIterations: 10,
      timeout: 30000
    },
    pretools: {
      enabled: true,
      autoInvoke: true, // Auto-invoke for code-related queries
      maxIterations: 5,
      timeout: 15000
    }
  },
  models: [
    // Mirrors qodercli 1.1.14 live catalog (/algo/api/v2/model/list?Encode=1).
    // qmodel_38max first = default model, matching the binary's exposed model.
    // Binary shows only qmodel_38max on its free-tier account; other keys are
    // valid upstream and become available for accounts that can use them.
    { id: "qmodel_38max", name: "Qwen3.8-Max" },
    {
      id: "cmodel",
      name: "Cantus 🧠",
      tools: true,     // Enable tools by default for cmodel
      thinking: "max" // Default thinking level for cmodel
    },
    { id: "qmodel_latest", name: "Qwen3.7-Max" },
    { id: "qmodel", name: "Qwen3.7-Plus" },
    { id: "kmodel_latest", name: "Kimi-K3" },
    { id: "kmodel", name: "Kimi-K2.7-Code" },
    { id: "gm51model", name: "GLM-5.2" },
    { id: "dmodel", name: "DeepSeek-V4-Pro" },
    { id: "dfmodel", name: "DeepSeek-V4-Flash" },
    { id: "mmodel", name: "MiniMax-M3" },
    { id: "auto", name: "Auto" },
    { id: "ultimate", name: "Ultimate" },
    { id: "performance", name: "Performance" },
    { id: "efficient", name: "Efficient" },
    { id: "lite", name: "Lite" },
  ],
  oauth: {
    openApiBaseUrl: "https://openapi.qoder.sh",
    centerBaseUrl: "https://center.qoder.sh",
    chatBaseUrl: "https://api2.qoder.sh",
    deviceTokenUrl: "https://openapi.qoder.sh/api/v1/deviceToken/poll",
    refreshUrl: "https://openapi.qoder.sh/api/v1/deviceToken/refresh",
    userInfoUrl: "https://openapi.qoder.sh/api/v1/userinfo",
    quotaUsageUrl: "https://openapi.qoder.sh/api/v2/quota/usage",
    loginUrl: "https://qoder.com/device/selectAccounts",
  },
  features: {
    usage: true,
  },
};
