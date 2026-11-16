import { describe, expect, test } from "bun:test";
import {
  addOutcome,
  canarySelected,
  classifyAttemptOutcome,
  decideRouteHealth,
  emptyRouteHealthCounts,
} from "../engine/routeHealth/decision";
import { DEFAULT_ROUTE_HEALTH_POLICY, parseRouteHealthPolicy } from "../engine/routeHealth/policy";
import { overrideExpiryDate, routeHealthRank } from "../engine/routeHealth/override";
import { RouteHealthProbeService } from "../engine/routeHealth/RouteHealthProbeService";
import {
  VisibleRailsResolver,
  type CredentialSetRecord,
  type RailRecord,
  type RailRouteRecord,
  type VisibleRailsInput,
} from "../engine/flow/VisibleRailsResolver";

const policy = DEFAULT_ROUTE_HEALTH_POLICY;

const counts = (successes: number, definitiveFailures: number, ambiguousUnknowns = 0) => ({
  ...emptyRouteHealthCounts(),
  successes,
  definitiveFailures,
  ambiguousUnknowns,
});

describe("route health classifier", () => {
  test("counts only definitive gateway faults", () => {
    expect(classifyAttemptOutcome({ status: "SUCCEEDED" })).toBe("SUCCESS");
    expect(classifyAttemptOutcome({ status: "REFUNDED" })).toBe("SUCCESS");
    expect(classifyAttemptOutcome({ status: "UNKNOWN" })).toBe("AMBIGUOUS");
    expect(classifyAttemptOutcome({ status: "FAILED", canonicalError: "GATEWAY_TIMEOUT" })).toBe("DEFINITIVE_FAILURE");
    expect(classifyAttemptOutcome({ status: "FAILED", canonicalError: "HTTP 503" })).toBe("DEFINITIVE_FAILURE");
    expect(classifyAttemptOutcome({ status: "FAILED", canonicalError: "TERMINAL_DECLINE" })).toBe("IGNORED");
    expect(classifyAttemptOutcome({ status: "FAILED", canonicalError: "RETRYABLE_OTP" })).toBe("IGNORED");
    expect(classifyAttemptOutcome({ status: "FAILED", canonicalError: "LIMIT_EXCEEDED" })).toBe("IGNORED");
    expect(classifyAttemptOutcome({ status: "FAILED", canonicalError: "HTTP 429" })).toBe("RATE_LIMITED");
    expect(classifyAttemptOutcome({ status: "EXPIRED" })).toBe("IGNORED");
    expect(classifyAttemptOutcome({ status: "BLOCKED" })).toBe("IGNORED");
  });

  test("honours the error map over string heuristics", () => {
    expect(
      classifyAttemptOutcome({
        status: "FAILED",
        canonicalError: "GATEWAY_TIMEOUT",
        errorMap: { classification: "CUSTOMER", countsTowardBreaker: false },
      }),
    ).toBe("IGNORED");
    expect(
      classifyAttemptOutcome({
        status: "FAILED",
        canonicalError: "SOMETHING_NEW",
        errorMap: { classification: "GATEWAY_FAULT", countsTowardBreaker: true },
      }),
    ).toBe("DEFINITIVE_FAILURE");
    expect(
      classifyAttemptOutcome({
        status: "FAILED",
        canonicalError: "SOMETHING_NEW",
        errorMap: { classification: "AMBIGUOUS", countsTowardBreaker: true },
      }),
    ).toBe("AMBIGUOUS");
  });

  test("counts are accumulated into the right buckets", () => {
    let value = emptyRouteHealthCounts();
    for (const outcome of ["SUCCESS", "DEFINITIVE_FAILURE", "AMBIGUOUS", "RATE_LIMITED", "IGNORED"] as const) {
      value = addOutcome(value, outcome);
    }
    expect(value).toEqual({ successes: 1, definitiveFailures: 1, ambiguousUnknowns: 1, rateLimits429: 1, ignoredOutcomes: 1 });
  });
});

describe("route health decision", () => {
  test("degrades and opens at the configured traffic thresholds", () => {
    expect(
      decideRouteHealth({ current: "HEALTHY", counts: counts(7, 3), consecutiveFailures: 3, probeSuccesses: 0, policy }).state,
    ).toBe("DEGRADED");
    expect(
      decideRouteHealth({ current: "HEALTHY", counts: counts(4, 6), consecutiveFailures: 6, probeSuccesses: 0, policy }).state,
    ).toBe("OPEN_BREAKER");
  });

  test("a degraded route can recover from canary traffic or probes", () => {
    expect(
      decideRouteHealth({ current: "DEGRADED", counts: counts(10, 0), consecutiveFailures: 0, probeSuccesses: 0, policy }).state,
    ).toBe("HEALTHY");
    expect(
      decideRouteHealth({ current: "DEGRADED", counts: emptyRouteHealthCounts(), consecutiveFailures: 0, probeSuccesses: 2, policy }).state,
    ).toBe("HEALTHY");
    expect(
      decideRouteHealth({ current: "DEGRADED", counts: counts(0, 6), consecutiveFailures: 6, probeSuccesses: 0, policy }).state,
    ).toBe("OPEN_BREAKER");
  });

  test("an open breaker only recovers through probes", () => {
    expect(
      decideRouteHealth({ current: "OPEN_BREAKER", counts: counts(100, 0), consecutiveFailures: 0, probeSuccesses: 2, policy }).state,
    ).toBe("OPEN_BREAKER");
    expect(
      decideRouteHealth({ current: "OPEN_BREAKER", counts: emptyRouteHealthCounts(), consecutiveFailures: 0, probeSuccesses: 3, policy }).state,
    ).toBe("HEALTHY");
  });

  test("effective health ranks override above computed", () => {
    expect(routeHealthRank.HEALTHY).toBeGreaterThan(routeHealthRank.DEGRADED);
    expect(routeHealthRank.DEGRADED).toBeGreaterThan(routeHealthRank.OPEN_BREAKER);
  });
});

describe("route health policy and canary", () => {
  test("malformed settings fall back and values are clamped", () => {
    const parsed = parseRouteHealthPolicy({
      mode: "BROKEN",
      degradeErrorRate: 4,
      canaryPercent: -3,
      minOutcomes: 0,
      canaryMaxAmount: "",
    });
    expect(parsed.mode).toBe("ENFORCE");
    expect(parsed.degradeErrorRate).toBe(1);
    expect(parsed.canaryPercent).toBe(0);
    expect(parsed.minOutcomes).toBe(1);
    expect(parsed.canaryMaxAmount).toBeNull();
    expect(parseRouteHealthPolicy({ minOutcomes: null, openErrorRate: "", canaryMaxAmount: "abc" }).minOutcomes).toBe(10);
    expect(parseRouteHealthPolicy({ minOutcomes: null, openErrorRate: "", canaryMaxAmount: "abc" }).openErrorRate).toBe(0.6);
    expect(parseRouteHealthPolicy({ canaryMaxAmount: "1,000" }).canaryMaxAmount).toBeNull();
    expect(parseRouteHealthPolicy({ canaryMaxAmount: "-1" }).canaryMaxAmount).toBeNull();
    expect(parseRouteHealthPolicy({ canaryMaxAmount: "25.5" }).canaryMaxAmount).toBe("25.5000");
    expect(parseRouteHealthPolicy({ probeBackoffMaxSeconds: 1, probeIntervalSeconds: 60 }).probeBackoffMaxSeconds).toBe(60);
  });

  test("a manual probe failure opens a degraded route", () => {
    const decision = decideRouteHealth({
      current: "DEGRADED",
      counts: emptyRouteHealthCounts(),
      consecutiveFailures: 0,
      probeSuccesses: 0,
      probeFailures: 1,
      policy,
    });
    expect(decision.state).toBe("OPEN_BREAKER");
  });

  test("canary membership is stable and bounded", () => {
    expect(canarySelected("route-1", "link-1", 0)).toBe(false);
    expect(canarySelected("route-1", "link-1", 100)).toBe(true);
    expect(canarySelected("route-1", "link-1", 5)).toBe(canarySelected("route-1", "link-1", 5));
    expect(canarySelected("route-1", null, 5)).toBe(false);
  });

  test("override expiry is future-only and capped at 30 days", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    expect(overrideExpiryDate(undefined, now).getTime()).toBe(now.getTime() + 7 * 86_400_000);
    expect(() => overrideExpiryDate(now, now)).toThrow();
    expect(() => overrideExpiryDate(new Date(now.getTime() + 31 * 86_400_000), now)).toThrow();
  });
});

describe("degraded canary routing", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");
  const rail: RailRecord = {
    id: "rail-sadad",
    code: "sadad",
    nameEn: "Sadad",
    currency: "LYD",
    blocked: false,
    displayOrder: 1,
    collectionMode: "OTP_PULL",
  };
  const route = (id: string, healthState: "HEALTHY" | "DEGRADED" | "OPEN_BREAKER"): RailRouteRecord => ({
    id,
    railId: rail.id,
    gatewayId: "gateway-1",
    credentialPolicy: "PLATFORM",
    priority: 1,
    routingStrategy: "EFFECTIVE_COST",
    weight: 100,
    costModel: { flat: "1", percent: "0.5" },
    minAmount: "1.0000",
    maxAmount: "10000.0000",
    dailyCapAmount: null,
    dailyProcessedAmount: "0.0000",
    status: "ACTIVE",
    healthState,
    maintenanceWindows: [],
    scope: {},
  });
  const credentials: CredentialSetRecord[] = [{
    id: "credential-1",
    gatewayId: "gateway-1",
    env: "LIVE",
    ownerType: "PLATFORM",
    ownerMerchantId: null,
    settlementTarget: "PLATFORM_CLEARING",
    status: "VERIFIED",
  }];
  const input = (healthState: "DEGRADED" | "OPEN_BREAKER", percent: number): VisibleRailsInput => ({
    application: { id: "app-1", merchantId: "merchant-1", riskTier: "LOW", railWhitelist: null },
    link: { amount: "100.0000", currency: "LYD", railWhitelist: null },
    channel: "WEB",
    env: "LIVE",
    rails: [rail],
    routes: [route("route-healthy", "HEALTHY"), route("route-degraded", healthState)],
    credentialSets: credentials,
    commissionProfiles: [{
      id: "commission-1",
      merchantId: "merchant-1",
      applicationId: "app-1",
      railCode: "sadad",
      effectiveFrom: new Date(now.getTime() - 86_400_000),
      status: "ACTIVE",
    }],
    canaryKey: "link-1",
    canaryPercent: percent,
    now,
  });

  test("a degraded route is excluded when canary is off", () => {
    const result = new VisibleRailsResolver().resolve(input("DEGRADED", 0));
    expect(result.rails).toHaveLength(1);
    expect(result.rails[0]?.routes.map((entry) => entry.route.id)).toEqual(["route-healthy"]);
    expect(result.excluded.some((entry) => entry.reason === "ROUTE_NOT_HEALTHY")).toBe(true);
  });

  test("a degraded route is tried first for a 100% canary cohort", () => {
    const result = new VisibleRailsResolver().resolve(input("DEGRADED", 100));
    expect(result.rails[0]?.routes.map((entry) => entry.route.id)).toEqual(["route-degraded", "route-healthy"]);
  });

  test("an expired admin override is ignored lazily", () => {
    const result = new VisibleRailsResolver().resolve({
      ...input("DEGRADED", 0),
      routes: [{
        ...route("route-expired", "HEALTHY"),
        healthComputedState: "HEALTHY",
        healthOverrideState: "OPEN_BREAKER",
        healthOverrideExpiresAt: new Date(now.getTime() - 1000),
      }],
    });
    expect(result.rails[0]?.routes.map((entry) => entry.route.id)).toEqual(["route-expired"]);
  });

  test("an open breaker is never canary-eligible", () => {
    const result = new VisibleRailsResolver().resolve(input("OPEN_BREAKER", 100));
    expect(result.rails[0]?.routes.map((entry) => entry.route.id)).toEqual(["route-healthy"]);
    expect(result.excluded.some((entry) => entry.reason === "ROUTE_NOT_HEALTHY")).toBe(true);
  });
});

describe("route health probes", () => {
  test("a merchant-required route is skipped rather than probing a merchant login", async () => {
    let credentialLookup = 0;
    const db = {
      railRoute: { findUnique: async () => ({ id: "route-1", gatewayId: "gateway-1", credentialPolicy: "MERCHANT_REQUIRED" }) },
      credentialSet: { findFirst: async () => { credentialLookup += 1; return { id: "credential-1" }; } },
      gateway: { findUnique: async () => ({ activeVersionId: "version-1" }) },
    };
    const probe = new RouteHealthProbeService(db as never, {
      verify: async () => ({ status: "VERIFIED", method: "FLOW" }),
    });
    const result = await probe.probe("route-1");
    expect(result.status).toBe("SKIPPED");
    expect(result.reason).toBe("MERCHANT_CREDENTIAL_REQUIRED");
    expect(credentialLookup).toBe(0);
  });

  test("a platform probe uses the credential-check flow without persisting a verdict", async () => {
    let options: unknown = null;
    const db = {
      railRoute: { findUnique: async () => ({ id: "route-1", gatewayId: "gateway-1", credentialPolicy: "PLATFORM" }) },
      credentialSet: { findFirst: async () => ({ id: "credential-1" }) },
      gateway: { findUnique: async () => ({ activeVersionId: "version-1" }) },
    };
    const probe = new RouteHealthProbeService(db as never, {
      verify: async (_id: string, received?: { persist?: boolean }) => {
        options = received;
        return { status: "VERIFIED", method: "FLOW", httpStatus: 200 };
      },
    });
    const result = await probe.probe("route-1");
    expect(result).toMatchObject({ status: "PASSED", method: "CREDENTIAL_CHECK", httpStatus: 200 });
    expect(options).toMatchObject({ persist: false, gatewayVersionId: "version-1" });
  });
});
