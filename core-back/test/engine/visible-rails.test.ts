import { describe, expect, test } from "bun:test";
import {
  VisibleRailsResolver,
  type RouteHealthState,
  type RouteStatus,
} from "../../engine/flow/VisibleRailsResolver";

type CredentialStatus = "UNTESTED" | "VERIFIED" | "FAILING" | "REVOKED";

const NOW = new Date("2026-03-01T00:00:00Z");

type RailChannel = "WEB" | "API" | "POS";

type TestRoute = {
  id: string;
  railId: string;
  gatewayId: string;
  credentialPolicy: "PLATFORM";
  priority: number;
  status: RouteStatus;
  healthState: RouteHealthState;
  minAmount: string;
  maxAmount: string;
  dailyCapAmount: string;
  dailyProcessedAmount: string;
  costModel: { calc_type: "PERCENTAGE" | "FLAT"; percent?: string; flat?: string };
  scope: { merchant_ids?: string[]; channels?: RailChannel[] } | null;
  maintenanceWindows?: Array<{ start: Date; end: Date }>;
};

type TestCredentialSet = {
  id: string;
  gatewayId: string;
  env: "SANDBOX";
  ownerType: "PLATFORM";
  ownerMerchantId: null;
  settlementTarget: "PLATFORM_CLEARING";
  status: CredentialStatus;
};

const baseInput = (): {
  application: { id: string; merchantId: string; riskTier: string; railWhitelist: readonly string[] | null };
  link: { amount: string; currency: string; railWhitelist: readonly string[] | null };
  channel: "WEB";
  env: "SANDBOX";
  now: Date;
  rails: Array<{ id: string; code: string; currency: string; blocked?: boolean }>;
  routes: TestRoute[];
  credentialSets: TestCredentialSet[];
  commissionProfiles: Array<{
    id: string;
    merchantId: string | null;
    applicationId: string | null;
    railCode: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    status: "ACTIVE";
  }>;
} => ({
  application: {
    id: "app-1",
    merchantId: "merchant-1",
    riskTier: "STANDARD",
    railWhitelist: null as readonly string[] | null,
  },
  link: {
    amount: "100.0000",
    currency: "LYD",
    railWhitelist: null as readonly string[] | null,
  },
  channel: "WEB" as const,
  env: "SANDBOX" as const,
  now: NOW,
  rails: [
    { id: "rail-edfali", code: "edfali", currency: "LYD" },
    { id: "rail-lypay", code: "lypay", currency: "LYD" },
    { id: "rail-blocked", code: "blocked_rail", currency: "LYD", blocked: true },
    { id: "rail-usd", code: "usd_rail", currency: "USD" },
  ],
  routes: [
    {
      id: "route-edfali-direct",
      railId: "rail-edfali",
      gatewayId: "gw-direct",
      credentialPolicy: "PLATFORM" as const,
      priority: 10,
      status: "ACTIVE" as const,
      healthState: "HEALTHY" as const,
      minAmount: "1.0000",
      maxAmount: "1000.0000",
      dailyCapAmount: "5000.0000",
      dailyProcessedAmount: "0.0000",
      costModel: { calc_type: "PERCENTAGE" as const, percent: "1.0" },
      scope: null,
    },
    {
      id: "route-edfali-aggregator",
      railId: "rail-edfali",
      gatewayId: "gw-aggregator",
      credentialPolicy: "PLATFORM" as const,
      priority: 5,
      status: "ACTIVE" as const,
      healthState: "HEALTHY" as const,
      minAmount: "1.0000",
      maxAmount: "1000.0000",
      dailyCapAmount: "5000.0000",
      dailyProcessedAmount: "0.0000",
      costModel: { calc_type: "PERCENTAGE" as const, percent: "0.5" },
      scope: null,
    },
    {
      id: "route-lypay",
      railId: "rail-lypay",
      gatewayId: "gw-lypay",
      credentialPolicy: "PLATFORM" as const,
      priority: 10,
      status: "ACTIVE" as const,
      healthState: "HEALTHY" as const,
      minAmount: "1.0000",
      maxAmount: "1000.0000",
      dailyCapAmount: "5000.0000",
      dailyProcessedAmount: "0.0000",
      costModel: { calc_type: "FLAT" as const, flat: "0.8" },
      scope: null,
    },
  ],
  credentialSets: [
    { id: "cs-direct", gatewayId: "gw-direct", env: "SANDBOX" as const, ownerType: "PLATFORM" as const, ownerMerchantId: null, settlementTarget: "PLATFORM_CLEARING" as const, status: "VERIFIED" as const },
    { id: "cs-aggregator", gatewayId: "gw-aggregator", env: "SANDBOX" as const, ownerType: "PLATFORM" as const, ownerMerchantId: null, settlementTarget: "PLATFORM_CLEARING" as const, status: "VERIFIED" as const },
    { id: "cs-lypay", gatewayId: "gw-lypay", env: "SANDBOX" as const, ownerType: "PLATFORM" as const, ownerMerchantId: null, settlementTarget: "PLATFORM_CLEARING" as const, status: "VERIFIED" as const },
  ],
  commissionProfiles: [
    {
      id: "cp-edfali",
      merchantId: null,
      applicationId: null,
      railCode: "edfali",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      effectiveTo: null,
      status: "ACTIVE" as const,
    },
    {
      id: "cp-lypay",
      merchantId: null,
      applicationId: null,
      railCode: "lypay",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      effectiveTo: null,
      status: "ACTIVE" as const,
    },
  ],
});

describe("visible rails formula", () => {
  const resolver = new VisibleRailsResolver();

  test("returns only rails with a live commission profile and an eligible route", () => {
    const result = resolver.resolve(baseInput());
    const codes = result.rails.map((entry) => entry.rail.code);
    expect(codes).toContain("edfali");
    expect(codes).toContain("lypay");
    expect(codes).not.toContain("blocked_rail");
    expect(codes).not.toContain("usd_rail");
  });

  test("intersects the application and link whitelists", () => {
    const input = baseInput();
    input.application.railWhitelist = ["edfali", "lypay"];
    input.link.railWhitelist = ["edfali"];
    const result = resolver.resolve(input);
    expect(result.rails.map((entry) => entry.rail.code)).toEqual(["edfali"]);
  });

  test("excludes a rail without a live commission profile", () => {
    const input = baseInput();
    input.commissionProfiles = input.commissionProfiles.filter((profile) => profile.railCode !== "edfali");
    const result = resolver.resolve(input);
    expect(result.rails.map((entry) => entry.rail.code)).toEqual(["lypay"]);
  });

  test("excludes a rail whose commission profile is not effective yet", () => {
    const input = baseInput();
    input.commissionProfiles = input.commissionProfiles.map((profile) => ({
      ...profile,
      effectiveFrom: new Date("2027-01-01T00:00:00Z"),
    }));
    const result = resolver.resolve(input);
    expect(result.rails).toHaveLength(0);
  });

  test("excludes a route whose amount is outside its limits", () => {
    const input = baseInput();
    input.link.amount = "5000.0000";
    const result = resolver.resolve(input);
    expect(result.rails.map((entry) => entry.rail.code)).toEqual([]);
  });

  test("excludes a route whose daily cap would be exceeded", () => {
    const input = baseInput();
    input.routes = input.routes.map((route) => ({ ...route, dailyProcessedAmount: "4999.0000" }));
    const result = resolver.resolve(input);
    expect(result.rails.map((entry) => entry.rail.code)).toEqual([]);
  });

  test("excludes a route inside a maintenance window", () => {
    const input = baseInput();
    input.routes = input.routes.map((route) => ({
      ...route,
      maintenanceWindows: [
        { start: new Date("2026-02-01T00:00:00Z"), end: new Date("2026-04-01T00:00:00Z") },
      ],
    }));
    const result = resolver.resolve(input);
    expect(result.rails).toHaveLength(0);
  });

  test("excludes a route that is not HEALTHY or not ACTIVE", () => {
    const input = baseInput();
    input.routes = input.routes.map((route) => ({ ...route, status: "PAUSED" as RouteStatus }));
    expect(resolver.resolve(input).rails).toHaveLength(0);
    const degraded = baseInput();
    degraded.routes = degraded.routes.map((route) => ({ ...route, healthState: "DEGRADED" as RouteHealthState }));
    expect(resolver.resolve(degraded).rails).toHaveLength(0);
  });

  test("excludes a route whose credential set is not VERIFIED", () => {
    const input = baseInput();
    input.credentialSets = input.credentialSets.map((credential) => (
      credential.id === "cs-direct" ? { ...credential, status: "UNTESTED" as CredentialStatus } : credential
    ));
    const result = resolver.resolve(input);
    const edfali = result.rails.find((entry) => entry.rail.code === "edfali");
    expect(edfali?.routes.map((route) => route.route.id)).toEqual(["route-edfali-aggregator"]);
  });

  test("excludes a route whose scope does not include the merchant or channel", () => {
    const input = baseInput();
    input.routes = input.routes.map((route) => ({
      ...route,
      scope: { merchant_ids: ["another-merchant"] },
    }));
    expect(resolver.resolve(input).rails).toHaveLength(0);

    const channelScoped = baseInput();
    channelScoped.routes = channelScoped.routes.map((route) => ({
      ...route,
      scope: { channels: ["POS" as const] },
    }));
    expect(resolver.resolve(channelScoped).rails).toHaveLength(0);
  });

  test("excludes a rail whose currency does not match the link currency", () => {
    const input = baseInput();
    input.link.currency = "USD";
    expect(resolver.resolve(input).rails).toHaveLength(0);
  });
});

describe("route ranking", () => {
  const resolver = new VisibleRailsResolver();

  test("orders routes by effective cost then priority", () => {
    const result = resolver.resolve(baseInput());
    const edfali = result.rails.find((entry) => entry.rail.code === "edfali");
    expect(edfali?.routes.map((route) => route.route.id)).toEqual([
      "route-edfali-aggregator",
      "route-edfali-direct",
    ]);
    expect(edfali?.routes[0]?.rank).toBe(1);
  });

  test("a higher priority wins when the effective cost is equal", () => {
    const input = baseInput();
    input.routes = input.routes.map((route) => ({
      ...route,
      costModel: { calc_type: "FLAT" as const, flat: "0.5" },
    }));
    const result = resolver.resolve(input);
    const edfali = result.rails.find((entry) => entry.rail.code === "edfali");
    expect(edfali?.routes.map((route) => route.route.id)).toEqual([
      "route-edfali-direct",
      "route-edfali-aggregator",
    ]);
  });

  test("the strict priority strategy ignores cost", () => {
    const input = baseInput();
    input.routes = input.routes.map((route) => ({
      ...route,
      routingStrategy: "STRICT_PRIORITY" as const,
    }));
    const result = resolver.resolve(input);
    const edfali = result.rails.find((entry) => entry.rail.code === "edfali");
    expect(edfali?.routes.map((route) => route.route.id)).toEqual([
      "route-edfali-direct",
      "route-edfali-aggregator",
    ]);
  });

  test("the effective cost is computed with decimal arithmetic", () => {
    const result = resolver.resolve(baseInput());
    const edfali = result.rails.find((entry) => entry.rail.code === "edfali");
    const direct = edfali?.routes.find((route) => route.route.id === "route-edfali-direct");
    expect(direct?.effectiveCost.toFixed(4)).toBe("1.0000");
  });
});
