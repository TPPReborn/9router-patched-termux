export default {
  id: "opencode",
  priority: 20, // Higher priority (lower number = higher priority) for faster selection
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free ⚡", // Added lightning bolt to indicate fast
    icon: "bolt", // Changed to lightning bolt for speed indication
    color: "#FFD700", // Changed to gold/yellow for attention
    textIcon: "OC⚡", // Lightning bolt in text icon
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
      "Accept": "text/event-stream", // Explicit streaming for faster chunk delivery
      "Cache-Control": "no-cache", // Force fresh responses
      "Connection": "keep-alive", // Keep connection alive for subsequent requests
    },
    timeoutMs: 30000, // Increased timeout for reliability
    noAuth: true,
  },
  models: [],
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
  // Thinking config — enabled with max effort for highest quality
  thinkingConfig: {
    options: ["off", "low", "medium", "high", "max"],
    defaultMode: "off", // THINK OFF — free tier quota, fast responses
  },
  regions: ["global"],
  defaultRegion: "global",
};
