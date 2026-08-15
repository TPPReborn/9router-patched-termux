import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import {
  rateLimitCheck,
  rateLimitSuccess,
  rateLimitBackoff,
} from "../utils/rateLimiter.js";
import { airplaneCycle, airplaneCycleBrief, airplaneAvailable } from "../utils/airplane-circle.js";

// Models that use /zen/v1/messages (claude format)
const MESSAGES_MODELS = new Set();

// Per-request fingerprint rotation — mimic unique client identity so
// upstream doesn't collapse all requests into one free-tier bucket.
let fingerprintCounter = 0;
function generateFingerprint() {
  fingerprintCounter += 1;
  const rand = Math.floor(Math.random() * 1e9);
  const ts = Date.now().toString(16);
  const counter = fingerprintCounter.toString(16).padStart(4, "0");
  // Stable-ish but unique per request: machine-id + counter + random
  return `oc-${ts.slice(-6)}-${counter}-${rand.toString(16)}`;
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  transformRequest(model, body) {
    // THINK OFF — deepseek-v4-flash-free default already non-thinking.
    // Explicitly strip any reasoning/thinking budget to keep responses fast
    // and avoid burning quota on extended deliberation.
    const stripped = { ...body };
    delete stripped.reasoning_effort;
    delete stripped.thinking;
    delete stripped.budget_tokens;
    return injectReasoningContent({ provider: this.provider, model, body: stripped });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return MESSAGES_MODELS.has(model)
      ? `${base}/zen/v1/messages`
      : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders() {
    // Rotate fingerprint headers to appear as unique clients (mimics
    // multiple users hitting the free API). Upstream enforces per-IP
    // free-tier limits; per-request fingerprinting spreads the bucket.
    const fp = generateFingerprint();
    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "x-opencode-client": "desktop",
      "x-opencode-session-id": fp,       // Unique session per request
      "x-opencode-instance-id": `inst-${fp}`, // Unique instance
      "Accept": "text/event-stream",
      "Cache-Control": "no-cache",
      "User-Agent": `opencode-free/${fp.slice(0, 8)}`,
    };
  }

  // Rate limiter + 429 backoff — only throttles AFTER a 429 was seen.
  // Normal requests flow without gap so tool-heavy tasks aren't slowed.
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const limiterCfg = {
      minGapMs: 0,           // no throttle until a 429 happens
      backoff429Ms: 15_000,  // 15s cooldown after a 429
      maxBackoffMs: 60_000,
    };

    // Gate: wait only if a 429 backoff is active
    const check = rateLimitCheck(this.provider, limiterCfg);
    if (!check.allowed) {
      log?.info?.("RATELIMIT", `${this.provider.toUpperCase()} | backoff wait ${Math.round(check.waitMs / 1000)}s (post-429)`);
      await new Promise(r => setTimeout(r, check.waitMs));
    }

    const result = await super.execute({ model, body, stream, credentials, signal, log, proxyOptions });

    // Inspect response for 429 → apply backoff + airplane cycle fallback
    const status = result?.response?.status;
    if (status === 429) {
      const backoff = rateLimitBackoff(this.provider, limiterCfg);
      log?.warn?.("RATELIMIT", `${this.provider.toUpperCase()} | 429 → backoff ${Math.round(backoff / 1000)}s`);

      // Free-tier fallback: toggle airplane mode to force fresh network
      // identity (new IP) when we're on a direct/proxy strategy and keep
      // getting hard-limited. This is the qoder-claim "airplane cycle" trick.
      const tryAirplane =
        airplaneAvailable() &&
        !proxyOptions?.vercelRelayUrl &&          // skip if relay (IP not ours anyway)
        !proxyOptions?.connectionProxyUrl;        // only for direct connection

      if (tryAirplane) {
        log?.info?.("RATELIMIT", `${this.provider.toUpperCase()} | airplane-cycle fallback (direct strategy, 429) — toggling network`);
        const cycled = await airplaneCycle({ settleMs: 5_000 });
        if (cycled) {
          log?.info?.("RATELIMIT", `${this.provider.toUpperCase()} | airplane-cycle done — retrying request`);
          rateLimitSuccess(this.provider);
          // Re-run once after network reset
          try {
            const retryResult = await super.execute({ model, body, stream, credentials, signal, log, proxyOptions });
            const retryStatus = retryResult?.response?.status;
            if (retryStatus === 429) {
              rateLimitBackoff(this.provider, limiterCfg);
              log?.warn?.("RATELIMIT", `${this.provider.toUpperCase()} | still 429 after airplane-cycle`);
            } else {
              rateLimitSuccess(this.provider);
            }
            return retryResult;
          } catch (retryErr) {
            log?.warn?.("RATELIMIT", `${this.provider.toUpperCase()} | retry after airplane failed:`, retryErr?.message);
          }
        } else {
          log?.warn?.("RATELIMIT", `${this.provider.toUpperCase()} | airplane-cycle failed (no rish / no permission)`);
        }
      }
    } else if (status && status < 300) {
      rateLimitSuccess(this.provider);
    }

    return result;
  }
}
