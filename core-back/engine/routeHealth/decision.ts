import type {
  AttemptOutcomeClass,
  ErrorMapLike,
  RouteHealthCounts,
  RouteHealthDecision,
  RouteHealthPolicy,
  RouteHealthState,
} from "./types";

const TERMINAL_SUCCESS = new Set(["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"]);
const TERMINAL_IGNORED = new Set(["EXPIRED", "CANCELLED", "BLOCKED"]);

/**
 * Classifies one terminal (or still-open UNKNOWN) attempt for the breaker.
 * Customer errors never count; 429 is stored separately and never trips the breaker.
 */
export function classifyAttemptOutcome(input: {
  status: string;
  canonicalError?: string | null;
  substatus?: string | null;
  errorMap?: ErrorMapLike | null;
}): AttemptOutcomeClass {
  const status = String(input.status).toUpperCase();
  if (TERMINAL_SUCCESS.has(status)) return "SUCCESS";
  if (status === "UNKNOWN") return "AMBIGUOUS";
  if (TERMINAL_IGNORED.has(status)) return "IGNORED";
  if (status !== "FAILED") return "IGNORED";

  const error = String(input.canonicalError ?? input.substatus ?? "").toUpperCase();
  if (error.includes("429") || error.includes("RATE_LIMIT")) return "RATE_LIMITED";
  if (error.includes("RETRYABLE_OTP") || error.includes("TERMINAL_DECLINE") || error.includes("LIMIT_EXCEEDED")) {
    return "IGNORED";
  }
  if (input.errorMap) {
    if (input.errorMap.countsTowardBreaker !== true) return "IGNORED";
    const classification = String(input.errorMap.classification ?? "").toUpperCase();
    if (classification === "AMBIGUOUS") return "AMBIGUOUS";
    if (classification === "GATEWAY_FAULT") return "DEFINITIVE_FAILURE";
    return "IGNORED";
  }
  if (error.startsWith("HTTP 5") || error.includes("TIMEOUT") || error.includes("NETWORK") || error.includes("CONNECTION")) {
    return "DEFINITIVE_FAILURE";
  }
  if (error.includes("TRUSTED_SUCCESS") || error.includes("CONFLICTING_TRUSTED") || error.includes("AMBIGUOUS")) {
    return "AMBIGUOUS";
  }
  return "IGNORED";
}

export const emptyRouteHealthCounts = (): RouteHealthCounts => ({
  successes: 0,
  definitiveFailures: 0,
  ambiguousUnknowns: 0,
  rateLimits429: 0,
  ignoredOutcomes: 0,
});

export function addOutcome(counts: RouteHealthCounts, outcome: AttemptOutcomeClass): RouteHealthCounts {
  const next = { ...counts };
  if (outcome === "SUCCESS") next.successes += 1;
  else if (outcome === "DEFINITIVE_FAILURE") next.definitiveFailures += 1;
  else if (outcome === "AMBIGUOUS") next.ambiguousUnknowns += 1;
  else if (outcome === "RATE_LIMITED") next.rateLimits429 += 1;
  else next.ignoredOutcomes += 1;
  return next;
}

export interface DecideRouteHealthInput {
  current: RouteHealthState;
  counts: RouteHealthCounts;
  consecutiveFailures: number;
  probeSuccesses: number;
  probeFailures?: number;
  policy: RouteHealthPolicy;
}

/**
 * Pure route health policy. Evidence is evaluated only for the current state's run; the worker passes
 * counts since the last computed transition. A healthy route can degrade/open from traffic; a degraded route can
 * recover from canary traffic or probes, and open from worse traffic; an open route only recovers through probes.
 */
export function decideRouteHealth(input: DecideRouteHealthInput): RouteHealthDecision {
  const { current, counts, consecutiveFailures, probeSuccesses, probeFailures = 0, policy } = input;
  const counted = counts.successes + counts.definitiveFailures + counts.ambiguousUnknowns;
  const errors = counts.definitiveFailures + counts.ambiguousUnknowns;
  const rate = counted > 0 ? errors / counted : 0;
  const openByTraffic =
    consecutiveFailures >= policy.openConsecutive ||
    (counted >= policy.minOutcomes && rate >= policy.openErrorRate);
  const degradeByTraffic =
    consecutiveFailures >= policy.degradeConsecutive ||
    (counted >= policy.minOutcomes && rate >= policy.degradeErrorRate);
  const recoveredByTraffic =
    counted >= policy.degradedRecoverMinOutcomes && rate <= policy.degradedRecoverErrorRate;

  if (current === "OPEN_BREAKER") {
    if (probeSuccesses >= policy.recoverOpenProbes) {
      return { state: "HEALTHY", reason: "PROBES_RECOVERED", changed: true };
    }
    return { state: "OPEN_BREAKER", reason: "OPEN_BREAKER", changed: false };
  }
  if (current === "DEGRADED") {
    if (probeFailures > 0) {
      return { state: "OPEN_BREAKER", reason: "PROBE_FAILED", changed: true };
    }
    // Fresh traffic failure outranks a probe counter left over from an earlier recovery.
    if (openByTraffic) {
      return { state: "OPEN_BREAKER", reason: "TRAFFIC_OPEN_THRESHOLD", changed: true };
    }
    if (probeSuccesses >= policy.recoverDegradedProbes) {
      return { state: "HEALTHY", reason: "PROBES_RECOVERED", changed: true };
    }
    if (recoveredByTraffic) {
      return { state: "HEALTHY", reason: "CANARY_RECOVERED", changed: true };
    }
    return { state: "DEGRADED", reason: "DEGRADED", changed: false };
  }
  if (openByTraffic) {
    return { state: "OPEN_BREAKER", reason: "TRAFFIC_OPEN_THRESHOLD", changed: true };
  }
  if (degradeByTraffic) {
    return { state: "DEGRADED", reason: "TRAFFIC_DEGRADE_THRESHOLD", changed: true };
  }
  return { state: "HEALTHY", reason: "HEALTHY", changed: false };
}

/** Stable, cheap canary membership: the same route+link always gets the same answer. */
export function canarySelected(routeId: string, canaryKey: string | null | undefined, percent: number): boolean {
  if (!canaryKey || percent <= 0) return false;
  if (percent >= 100) return true;
  let hash = 2166136261;
  const text = `${routeId}:${canaryKey}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100 < percent;
}
