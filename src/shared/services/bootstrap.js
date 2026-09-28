import initializeApp from "./initializeApp.js";

// Skip during Next.js build/prerender — bootstrap would download cloudflared, init DNS, etc.
// Prefer src/instrumentation.js for process boot; this layout-side path remains as a
// fallback when instrumentation is unavailable (older builds / edge cases).
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build"
  || process.env.NEXT_PHASE === "phase-export"
  || process.env.NEXT_PHASE === "phase-static";

// Server-only singleton: guard via global so HMR / re-imports / instrumentation
// don't double-init.
if (typeof window === "undefined" && !isBuildPhase && !global.__appBootstrapped) {
  global.__appBootstrapped = true;
  initializeApp().catch((e) => console.error("[Bootstrap] init failed:", e.message));
}
