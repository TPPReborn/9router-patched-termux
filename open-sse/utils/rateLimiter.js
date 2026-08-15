// Rate limiter + 429 backoff for provider requests
// Simple token-bucket limiter with per-provider cooldown state.

const state = new Map(); // provider → { nextAllowedAt, backoffUntil }

export const RATE_LIMIT_DEFAULTS = {
  // Min gap between requests — only enforced AFTER a 429 was seen.
  // Normal requests flow without throttle (0ms gap) so tasks with many
  // tool calls aren't slowed. Once the provider returns 429, backoff kicks
  // in and gates until the cooldown clears.
  minGapMs: 0,             // no throttle until a 429 happens
  backoff429Ms: 15_000,    // 15s cooldown after 429
  maxBackoffMs: 60_000,
};

/**
 * Check if a request is allowed for the provider NOW.
 * Returns { allowed: boolean, waitMs: number, throttled: boolean }.
 * - allowed=true: proceed immediately (no gap unless in 429 backoff).
 * - allowed=false: caller should wait `waitMs` (we're in 429 backoff).
 */
export function rateLimitCheck(provider, opts = {}) {
  const cfg = { ...RATE_LIMIT_DEFAULTS, ...opts };
  const now = Date.now();

  let s = state.get(provider);
  if (!s) {
    s = { nextAllowedAt: now, backoffUntil: 0, consecutive429: 0 };
    state.set(provider, s);
  }

  // Only gate when a 429 backoff is active. Otherwise allow immediately.
  if (now < s.backoffUntil) {
    return { allowed: false, waitMs: s.backoffUntil - now, throttled: true };
  }

  return { allowed: true, waitMs: 0, throttled: false };
}

/**
 * Report a successful request — resets cooldown.
 */
export function rateLimitSuccess(provider) {
  const s = state.get(provider);
  if (s) {
    s.consecutive429 = 0;
    s.backoffUntil = 0;
  }
}

/**
 * Report a 429 (rate limited) response — backs off the provider.
 * Returns the backoff duration (ms) that was applied.
 */
export function rateLimitBackoff(provider, opts = {}) {
  const cfg = { ...RATE_LIMIT_DEFAULTS, ...opts };
  const now = Date.now();

  let s = state.get(provider);
  if (!s) {
    s = { nextAllowedAt: now, backoffUntil: 0, consecutive429: 0 };
    state.set(provider, s);
  }

  s.consecutive429 += 1;
  // Exponential backoff: base 15s, doubles per consecutive 429, capped at 60s
  const backoff = Math.min(
    cfg.backoff429Ms * Math.pow(2, s.consecutive429 - 1),
    cfg.maxBackoffMs
  );
  s.backoffUntil = now + backoff;

  // Also extend the min-gap window so we don't immediately re-fire
  const nextAllowed = Math.max(s.nextAllowedAt, now) + cfg.minGapMs;
  s.nextAllowedAt = nextAllowed;

  return backoff;
}

/**
 * Wait until the provider allows a request (sleep).
 * Returns wait time actually slept (ms). 0 = no wait needed.
 */
export async function rateLimitWait(provider, opts = {}) {
  const check = rateLimitCheck(provider, opts);
  if (check.allowed) return 0;
  await new Promise(r => setTimeout(r, check.waitMs));
  return check.waitMs;
}

/**
 * Reset all rate limit state (e.g. on server restart / config change).
 */
export function rateLimitReset(provider = null) {
  if (provider) state.delete(provider);
  else state.clear();
}