import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import {
  GROK_CLI_BASE_URL,
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_CLIENT_MODE,
  GROK_CLI_TOKEN_AUTH,
  GROK_CLI_USER_AGENT,
  GROK_CLI_VERSION,
} from "open-sse/config/grokCli.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Billing is the fast path. POST /responses for rate-limit headers is slow/flaky —
// only run when ?probe=1 explicitly.
const BILLING_URL = `${GROK_CLI_BASE_URL}/billing?format=credits`;
const RESPONSES_URL = `${GROK_CLI_BASE_URL}/responses`;

const BILLING_TIMEOUT_MS = 6_000;
const PROBE_TIMEOUT_MS = 6_000;

function grokHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": GROK_CLI_USER_AGENT || `grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`,
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER || "grok-shell",
    "x-grok-client-version": GROK_CLI_VERSION || "0.2.106",
    "x-grok-client-mode": GROK_CLI_CLIENT_MODE || "headless",
    "X-XAI-Token-Auth": GROK_CLI_TOKEN_AUTH || "xai-grok-cli",
  };
}

function pickRateLimitHeaders(res) {
  const out = {};
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k.startsWith("x-ratelimit-") && value != null && value !== "") {
      out[k] = value;
    }
  });
  return out;
}

function num(v) {
  if (v == null || v === "") return null;
  if (typeof v === "object" && v !== null && "val" in v) return num(v.val);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function unwrapBilling(billing) {
  if (!billing || typeof billing !== "object") {
    return { billingHint: null, credits: null };
  }
  const cfg =
    billing.config && typeof billing.config === "object" ? billing.config : billing;

  const prepaid = num(cfg.prepaidBalance ?? billing.prepaidBalance);
  const onCap = num(cfg.onDemandCap ?? billing.onDemandCap);
  const onUsed = num(cfg.onDemandUsed ?? billing.onDemandUsed);
  const monthlyLimit = num(cfg.monthlyLimit ?? cfg.monthly_limit ?? billing.monthlyLimit);
  const includedUsed = num(cfg.includedUsed ?? cfg.included_used ?? billing.includedUsed);
  const totalUsed = num(cfg.totalUsed ?? cfg.total_used ?? billing.totalUsed);

  let billingHint = null;
  const credits = {};

  if (monthlyLimit != null && monthlyLimit > 0) {
    const used = includedUsed ?? totalUsed ?? 0;
    const rem = Math.max(0, monthlyLimit - used);
    credits.monthly = { used, total: monthlyLimit, remaining: rem };
    billingHint = `${rem}/${monthlyLimit}`;
  }

  if (onCap != null && onCap > 0) {
    const used = Math.max(0, onUsed ?? 0);
    const rem = Math.max(0, onCap - used);
    credits.onDemand = { used, total: onCap, remaining: rem, exhausted: rem === 0 };
    if (!billingHint) billingHint = `${rem}/${onCap}`;
  } else if (onCap === 0) {
    // Free tier / no on-demand pot — not "exhausted"
    credits.onDemand = {
      used: Math.max(0, onUsed ?? 0),
      total: 0,
      remaining: 0,
      freeTier: true,
    };
    if (!billingHint) billingHint = "0/0";
  }

  if (prepaid != null && prepaid > 0) {
    credits.prepaid = { remaining: prepaid };
    if (!billingHint || billingHint === "0/0") billingHint = `${prepaid}/${prepaid}`;
  }

  return { billingHint, credits };
}

/**
 * GET /api/providers/[id]/grok-monitor?probe=0|1
 * Default probe=0 (billing only, ~1s). probe=1 also POSTs /responses for rate-limit headers.
 */
export async function GET(request, { params }) {
  const started = Date.now();
  try {
    const { id } = await params;
    const url = new URL(request.url);
    // probe=1 (or omitted) → rate-limit headers via POST /responses.
    // probe=0 → billing only (faster, no req/token limits).
    const probeParam = url.searchParams.get("probe");
    const doProbe = probeParam !== "0";

    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json(
        { ok: false, error: "Connection not found", connectionId: id, ms: Date.now() - started },
        { status: 404 },
      );
    }
    if (connection.provider !== "grok-cli" && connection.provider !== "gcli") {
      return NextResponse.json(
        { ok: false, error: "Not a grok-cli connection", connectionId: id, ms: Date.now() - started },
        { status: 400 },
      );
    }
    const accessToken = connection.accessToken;
    if (!accessToken) {
      return NextResponse.json(
        {
          ok: false,
          error: "No access token",
          connectionId: id,
          ms: Date.now() - started,
          summary: null,
          billingHint: null,
        },
        { status: 400 },
      );
    }

    const headers = grokHeaders(accessToken);

    // 1) Billing — always, fast
    let billingStatus = null;
    let billingError = null;
    let billingBody = null;
    try {
      const bRes = await fetch(BILLING_URL, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
      });
      billingStatus = bRes.status;
      const text = await bRes.text().catch(() => "");
      try {
        billingBody = text ? JSON.parse(text) : null;
      } catch {
        billingBody = { raw: text.slice(0, 400) };
      }
      if (!bRes.ok) billingError = `billing HTTP ${bRes.status}`;
    } catch (e) {
      billingError = e?.message || String(e);
    }

    // 2) Optional rate-limit probe
    let rateLimit = {};
    let probeStatus = null;
    let probeError = null;
    let probeBodyText = "";
    let probeSkipped = !doProbe;
    if (doProbe) {
      try {
        const pRes = await fetch(RESPONSES_URL, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: "grok-4.5",
            input: "OK",
            max_output_tokens: 8,
          }),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        probeStatus = pRes.status;
        rateLimit = pickRateLimitHeaders(pRes);
        probeBodyText = await pRes.text().catch(() => "");
        // 429 free-usage-exhausted often omits x-ratelimit-* headers; parse body instead.
        if (!pRes.ok && pRes.status !== 402 && Object.keys(rateLimit).length === 0) {
          probeError = `probe HTTP ${pRes.status}`;
        }
      } catch (e) {
        probeError = e?.message || String(e);
      }
    }

    const { billingHint, credits } = unwrapBilling(billingBody);

    // Prefer headers; fall back to body "tokens (actual/limit): X/Y" on exhausted 429.
    let remainingRequests = num(rateLimit["x-ratelimit-remaining-requests"]);
    let limitRequests = num(rateLimit["x-ratelimit-limit-requests"]);
    let remainingTokens = num(rateLimit["x-ratelimit-remaining-tokens"]);
    let limitTokens = num(rateLimit["x-ratelimit-limit-tokens"]);

    if ((remainingTokens == null || limitTokens == null) && probeBodyText) {
      // e.g. tokens (actual/limit): 1088252/1000000
      const m =
        probeBodyText.match(/tokens\s*\(actual\/limit\)\s*:\s*([\d.]+)\/([\d.]+)/i) ||
        probeBodyText.match(/tokens[^0-9]*([\d.]+)\s*\/\s*([\d.]+)/i);
      if (m) {
        const actual = Number(m[1]);
        const limit = Number(m[2]);
        if (Number.isFinite(actual) && Number.isFinite(limit) && limit > 0) {
          limitTokens = limit;
          remainingTokens = Math.max(0, limit - actual);
        }
      }
    }
    // free-usage-exhausted / 429 with no request headers → treat requests as 0 remaining if we know a default window
    if (
      remainingRequests == null &&
      limitRequests == null &&
      (probeStatus === 429 || /free-usage-exhausted|used all the included free usage/i.test(probeBodyText))
    ) {
      // No request quota in body; leave null rather than inventing limits.
    }

    // Clear probeError when we still produced usable remaining/limit labels.
    if (
      probeError &&
      ((remainingTokens != null && limitTokens != null) ||
        (remainingRequests != null && limitRequests != null))
    ) {
      probeError = null;
    }

    const summary = {
      remainingRequests,
      limitRequests,
      remainingTokens,
      limitTokens,
      // Always remaining/limit when both known
      requestsLabel:
        remainingRequests != null && limitRequests != null
          ? `${remainingRequests}/${limitRequests}`
          : null,
      tokensLabel:
        remainingTokens != null && limitTokens != null
          ? `${remainingTokens}/${limitTokens}`
          : null,
    };

    const hardError =
      billingError && !billingHint && !summary.requestsLabel && !summary.tokensLabel
        ? billingError
        : null;

    return NextResponse.json({
      ok: !hardError,
      connectionId: id,
      ms: Date.now() - started,
      billingStatus,
      billingError,
      billing: billingBody,
      billingHint,
      credits,
      probeStatus,
      probeError,
      probeSkipped,
      rateLimit,
      summary,
      error: hardError,
    });
  } catch (error) {
    console.log("grok-monitor error:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error?.message || "monitor failed",
        ms: Date.now() - started,
        summary: null,
        billingHint: null,
      },
      { status: 500 },
    );
  }
}
