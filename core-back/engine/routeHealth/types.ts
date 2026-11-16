export type RouteHealthState = "HEALTHY" | "DEGRADED" | "OPEN_BREAKER";
export type RouteHealthMode = "OFF" | "SHADOW" | "ENFORCE";

export interface RouteHealthPolicy {
  enabled: boolean;
  mode: RouteHealthMode;
  sampleBucketSeconds: number;
  windowSeconds: number;
  minOutcomes: number;
  degradeErrorRate: number;
  openErrorRate: number;
  degradeConsecutive: number;
  openConsecutive: number;
  recoverDegradedProbes: number;
  recoverOpenProbes: number;
  openCooldownSeconds: number;
  probeIntervalSeconds: number;
  probeBackoffMaxSeconds: number;
  canaryPercent: number;
  canaryMaxAmount: string | null;
  degradedRecoverMinOutcomes: number;
  degradedRecoverErrorRate: number;
  overrideDefaultExpiryDays: number;
  overrideMaxExpiryDays: number;
  overrideReviewHours: number;
}

export interface RouteHealthCounts {
  successes: number;
  definitiveFailures: number;
  ambiguousUnknowns: number;
  rateLimits429: number;
  ignoredOutcomes: number;
}

export interface RouteHealthDecision {
  state: RouteHealthState;
  reason: string;
  /** True when the state changed from the supplied current state. */
  changed: boolean;
}

export type AttemptOutcomeClass = "SUCCESS" | "DEFINITIVE_FAILURE" | "AMBIGUOUS" | "RATE_LIMITED" | "IGNORED";

export interface ErrorMapLike {
  classification?: string | null;
  countsTowardBreaker?: boolean | null;
}

export type RouteHealthProbeMethod = "CREDENTIAL_CHECK" | "BASE_URL" | "NONE";
export type RouteHealthProbeStatus = "PASSED" | "FAILED" | "SKIPPED";
