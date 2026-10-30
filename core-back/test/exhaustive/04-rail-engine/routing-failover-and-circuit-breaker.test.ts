/**
 * Suite 04.3 — routing, failover and circuit-breaker selection.
 *
 * Exercises the real `VisibleRailsResolver` ranking and the shared daily-cap
 * evaluator across every gateway code.
 */
import { describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import { ALL_GATEWAY_CODES, Xoshiro128StarStar } from "../_harness";
import {
  VisibleRailsResolver,
  evaluateRouteDailyCap,
  type CommissionProfileRecord,
  type CredentialSetRecord,
  type RailRecord,
  type RailRouteRecord,
  type RankedRoute,
  type RoutingStrategy,
} from "../../../engine/flow/VisibleRailsResolver";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const resolver = new VisibleRailsResolver();

const credential = (gateway: string): CredentialSetRecord => ({
  id: `cred-${gateway}`,
  gatewayId: gateway,
  env: "LIVE",
  ownerType: "PLATFORM",
  ownerMerchantId: null,
  settlementTarget: "PLATFORM_CLEARING",
  status: "VERIFIED",
});

const route = (
  gateway: string,
  overrides: Partial<RailRouteRecord> = {},
): RailRouteRecord => ({
  id: `route-${gateway}`,
  railId: "rail-1",
  gatewayId: gateway,
  credentialPolicy: "PLATFORM",
  priority: 1,
  routingStrategy: "EFFECTIVE_COST",
  weight: 100,
  costModel: { flat: "1" },
  minAmount: "0",
  maxAmount: "100000",
  dailyCapAmount: null,
  status: "ACTIVE",
  healthState: "HEALTHY",
  maintenanceWindows: [],
  scope: null,
  ...overrides,
});

const effectiveCost = (value: RailRouteRecord, amount: Decimal): Decimal => {
  const model = value.costModel ?? {};
  let cost = new Decimal(0);
  if (model.flat !== undefined) cost = cost.plus(String(model.flat));
  if (model.percent !== undefined) cost = cost.plus(amount.mul(String(model.percent)).div(100));
  if (model.calc_type === "TIERED" || model.calc_type === "HYBRID") {
    for (const tier of model.tiers ?? []) {
      if (tier.up_to === undefined || amount.lte(String(tier.up_to))) {
        if (tier.flat !== undefined) cost = cost.plus(String(tier.flat));
        if (tier.percent !== undefined) cost = cost.plus(amount.mul(String(tier.percent)).div(100));
        break;
      }
    }
  }
  if (model.min !== undefined) cost = Decimal.max(cost, new Decimal(String(model.min)));
  if (model.max !== undefined) cost = Decimal.min(cost, new Decimal(String(model.max)));
  return cost;
};

const COST_MODELS: Array<{ label: string; costModel: RailRouteRecord["costModel"] }> = [
  { label: "flat", costModel: { flat: "5" } },
  { label: "percent", costModel: { percent: "2" } },
  { label: "min-max", costModel: { flat: "1", percent: "1", min: "2", max: "3" } },
  {
    label: "tiered",
    costModel: {
      calc_type: "TIERED",
      tiers: [
        { up_to: "100", flat: "2" },
        { up_to: "1000", flat: "1" },
        { flat: "0.5" },
      ],
    },
  },
];

const STRATEGIES: RoutingStrategy[] = ["EFFECTIVE_COST", "STRICT_PRIORITY", "WEIGHTED"];

describe("Suite 04 · route ranking across every gateway", () => {
  for (const gateway of ALL_GATEWAY_CODES) {
    for (const strategy of STRATEGIES) {
      for (const model of COST_MODELS) {
        test(`${gateway} · ${strategy} · ${model.label} ranks deterministically`, () => {
          const amount = new Decimal("250.0000");
          const a = route(gateway, {
            routingStrategy: strategy,
            costModel: model.costModel,
            priority: 2,
            weight: 200,
          });
          const b = route(`${gateway}-b`, {
            routingStrategy: strategy,
            costModel: { flat: "9" },
            priority: 1,
            weight: 100,
          });
          const ranked = resolver.rankRoutes(
            [
              { route: a, credentialSet: credential(a.gatewayId) },
              { route: b, credentialSet: credential(b.gatewayId) },
            ],
            amount,
          );
          let expectedFirst: string;
          if (strategy === "STRICT_PRIORITY") {
            expectedFirst = a.gatewayId;
          } else if (strategy === "WEIGHTED") {
            expectedFirst = a.gatewayId;
          } else {
            const costA = effectiveCost(a, amount);
            const costB = effectiveCost(b, amount);
            if (costA.lt(costB)) {
              expectedFirst = a.gatewayId;
            } else if (costB.lt(costA)) {
              expectedFirst = b.gatewayId;
            } else {
              // tie: priority desc, then gateway id
              expectedFirst = a.priority >= b.priority ? a.gatewayId : b.gatewayId;
            }
          }
          expect(ranked[0]?.route.gatewayId).toBe(expectedFirst);
          expect(ranked.map((entry) => entry.rank)).toEqual([1, 2]);
          expect(ranked[0]?.effectiveCost).toBeInstanceOf(Decimal);
        });
      }
    }
  }
});

describe("Suite 04 · daily cap evaluator", () => {
  const caps = [null, "0", "50", "100", "1000"] as const;
  const processed = ["0", "10", "50", "100"] as const;
  const amounts = ["0.0001", "10", "50", "100", "1000"] as const;

  for (const cap of caps) {
    for (const used of processed) {
      for (const amount of amounts) {
        test(`cap=${cap ?? "none"} processed=${used} amount=${amount}`, () => {
          const result = evaluateRouteDailyCap(
            { dailyCapAmount: cap, dailyProcessedAmount: used },
            amount,
          );
          if (cap === null) {
            expect(result.withinCap).toBe(true);
            expect(result.cap).toBeNull();
            expect(result.remaining).toBeNull();
          } else {
            const expected = new Decimal(used).plus(amount).lte(new Decimal(cap));
            expect(result.withinCap).toBe(expected);
            expect(result.cap?.toFixed(4)).toBe(new Decimal(cap).toFixed(4));
            expect(result.remaining?.toFixed(4)).toBe(new Decimal(cap).minus(used).toFixed(4));
          }
        });
      }
    }
  }
});

const baseInput = (gateway: string, routes: RailRouteRecord[]) => {
  const rail: RailRecord = {
    id: "rail-1",
    code: "sadad",
    nameEn: "Sadad",
    currency: "LYD",
    blocked: false,
    displayOrder: 1,
    collectionMode: "OTP_PULL",
  };
  const commissionProfiles: CommissionProfileRecord[] = [{
    id: "commission-1",
    merchantId: "merchant-1",
    applicationId: "app-1",
    railCode: "sadad",
    effectiveFrom: new Date(NOW.getTime() - 86_400_000),
    status: "ACTIVE",
  }];
  return {
    application: { id: "app-1", merchantId: "merchant-1", riskTier: "LOW", railWhitelist: null },
    link: { amount: "100.0000", currency: "LYD", railWhitelist: null },
    channel: "WEB" as const,
    env: "LIVE" as const,
    rails: [rail],
    routes,
    credentialSets: routes.map((entry) => credential(entry.gatewayId)),
    commissionProfiles,
    now: NOW,
  };
};

describe("Suite 04 · failover and circuit breaker", () => {
  for (const gateway of ALL_GATEWAY_CODES) {
    for (const unhealthy of ["DEGRADED", "OPEN_BREAKER"] as const) {
      test(`${gateway} fails over to the healthy secondary route when the primary is ${unhealthy}`, () => {
        const primary = route(gateway, { id: `primary-${gateway}`, healthState: unhealthy });
        const secondary = route(`${gateway}-secondary`, { id: `secondary-${gateway}`, healthState: "HEALTHY" });
        const result = resolver.resolve(baseInput(gateway, [primary, secondary]));
        expect(result.rails).toHaveLength(1);
        expect(result.rails[0]?.routes.map((entry: RankedRoute) => entry.route.gatewayId)).toEqual([
          `${gateway}-secondary`,
        ]);
        expect(result.excluded.some((entry) => entry.reason === "ROUTE_NOT_HEALTHY")).toBe(true);
      });
    }

    test(`${gateway} excludes a DRAINING primary route`, () => {
      const primary = route(gateway, { id: `primary-${gateway}`, status: "DRAINING" });
      const secondary = route(`${gateway}-secondary`, { id: `secondary-${gateway}` });
      const result = resolver.resolve(baseInput(gateway, [primary, secondary]));
      expect(result.rails[0]?.routes[0]?.route.gatewayId).toBe(`${gateway}-secondary`);
      expect(result.excluded.some((entry) => entry.reason === "ROUTE_NOT_ACTIVE")).toBe(true);
    });

    test(`${gateway} excludes an amount above the route maximum`, () => {
      const only = route(gateway, { maxAmount: "50.0000" });
      const result = resolver.resolve(baseInput(gateway, [only]));
      expect(result.rails).toHaveLength(0);
      expect(result.excluded[0]?.reason).toBe("AMOUNT_ABOVE_MAXIMUM");
    });
  }

  test("deterministic fuzz of the ranking comparator", () => {
    const prng = new Xoshiro128StarStar("routing-fuzz");
    for (let index = 0; index < 60; index += 1) {
      const amount = new Decimal(prng.decimalString(1, 10_000, 4));
      const routes = Array.from({ length: prng.int(2, 4) }, (_, position) =>
        route(`gw-${prng.int(0, 4)}-${position}`, {
          id: `route-${position}-${prng.int(0, 9999)}`,
          priority: prng.int(0, 5),
          weight: prng.int(1, 200),
          costModel: { flat: prng.decimalString(0, 10, 2), percent: prng.decimalString(0, 5, 2) },
        }),
      );
      const ranked = resolver.rankRoutes(
        routes.map((entry) => ({ route: entry, credentialSet: credential(entry.gatewayId) })),
        amount,
      );
      let previous = new Decimal(-1);
      for (const entry of ranked) {
        expect(entry.effectiveCost.gte(previous)).toBe(true);
        previous = entry.effectiveCost;
      }
      expect(new Set(ranked.map((entry) => entry.route.id)).size).toBe(routes.length);
      expect(ranked.map((entry) => entry.rank)).toEqual(routes.map((_, index) => index + 1));
    }
  });
});
