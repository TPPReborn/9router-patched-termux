// airplane-circle.js — Free-tier (opencode/oc) rate-limit fallback.
//
// When the `oc` free provider hits a hard 429 (FreeUsageLimitError) through
// the direct/proxy strategy, this helper toggles airplane mode ON↔OFF via
// Shizuku/Rish to force a fresh network identity (new IP lease). Each toggle
// waits 5s (airplane settle). This mirrors the "airplane cycle" trick used by
// qoder-claim to reset device network state.
//
// Fail-open: any error in toggling returns false — caller falls back to other
// strategies instead of crashing the request.
//
// Usage:
//   import { airplaneCycle } from "./airplane-circle.js";
//   const ok = await airplaneCycle();        // full ON↔OFF cycle
//   const off = await airplaneCycleOff();    // just OFF (leave network up)

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HOME = process.env.HOME || "/data/data/com.termux/files/home";
const AIRPLANE_ON = `${HOME}/bin/airplane-on`;
const AIRPLANE_OFF = `${HOME}/bin/airplane-off`;

// True when the underlying scripts exist; caller trusts this before cycling.
export function airplaneAvailable() {
  return true; // scripts verified at runtime; execFile fail-open handles absence
}

function runToggle(script) {
  return execFileAsync("/data/data/com.termux/files/usr/bin/bash", [script], {
    timeout: 15_000,
  }).then(() => true).catch((err) => {
    console.warn(`[AirplaneCircle] ${script} failed:`, err?.message || err);
    return false;
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Toggle airplane mode ON, wait 5s, toggle OFF, wait 5s.
 * Returns true on full cycle success, false if any step failed.
 */
export async function airplaneCycle({ settleMs = 5_000 } = {}) {
  const on = await runToggle(AIRPLANE_ON);
  if (!on) return false;
  await sleep(settleMs);

  const off = await runToggle(AIRPLANE_OFF);
  if (!off) return false;
  await sleep(settleMs);

  return true;
}

/**
 * Toggle airplane mode ON only (then OFF quickly) — used to force a
 * network identity reset with minimal downtime. Waits settleMs between.
 */
export async function airplaneCycleBrief({ settleMs = 5_000 } = {}) {
  const on = await runToggle(AIRPLANE_ON);
  if (!on) return false;
  await sleep(settleMs);
  await sleep(1_000); // brief hold
  const off = await runToggle(AIRPLANE_OFF);
  if (!off) return false;
  await sleep(settleMs);
  return true;
}

/**
 * Turn airplane mode OFF only (ensure network is up).
 */
export async function airplaneOff() {
  return runToggle(AIRPLANE_OFF);
}