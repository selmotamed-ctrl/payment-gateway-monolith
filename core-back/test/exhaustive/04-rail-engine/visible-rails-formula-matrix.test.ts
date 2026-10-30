/**
 * Suite 04.2 — the Visible Rails Formula (§6 of design v5) across 960
 * deterministic permutations. Every term of the formula is a dimension of the
 * matrix and the expected exclusion reason is asserted.
 */
import { describe, expect, test } from "bun:test";
import {
  VisibleRailsResolver,
  type CommissionProfileRecord,
  type CredentialSetRecord,
  type RailRecord,
  type RailRouteRecord,
  type VisibleRailsInput,
  type RouteExclusionReason,
} from "../../../engine/flow/VisibleRailsResolver";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const resolver = new VisibleRailsResolver();

interface Case {
  whitelist: number;
  commission: "present" | "missing";
  status: "ACTIVE" | "PAUSED" | "DRAINING";
  health: "HEALTHY" | "DEGRADED" | "OPEN_BREAKER";
  amountBand: "ok" | "below" | "above";
  dailyCap: "none" | "ok" | "exceeded";
  maintenance: "outside" | "inside";
  scope: "in" | "out";
  credential: "VERIFIED" | "REVOKED";
  railState: "normal" | "blocked" | "currency";
}

const WHITELISTS: Array<{ app: string[] | null; link: string[] | null }> = [
  { app: null, link: null },
  { app: ["sadad"], link: null },
  { app: null, link: ["sadad"] },
  { app: ["sadad"], link: ["moamalat"] },
  { app: ["moamalat"], link: ["sadad"] },
];

const DIMENSIONS = {
  whitelist: [0, 1, 2, 3, 4] as const,
  commission: ["present", "missing"] as const,
  status: ["ACTIVE", "PAUSED", "DRAINING"] as const,
  health: ["HEALTHY", "DEGRADED", "OPEN_BREAKER"] as const,
  amountBand: ["ok", "below", "above"] as const,
  dailyCap: ["none", "ok", "exceeded"] as const,
  maintenance: ["outside", "inside"] as const,
  scope: ["in", "out"] as const,
  credential: ["VERIFIED", "REVOKED"] as const,
  railState: ["normal", "blocked", "currency"] as const,
};

const allCases: Case[] = [];
for (const whitelist of DIMENSIONS.whitelist) {
  for (const commission of DIMENSIONS.commission) {
    for (const status of DIMENSIONS.status) {
      for (const health of DIMENSIONS.health) {
        for (const amountBand of DIMENSIONS.amountBand) {
          for (const dailyCap of DIMENSIONS.dailyCap) {
            for (const maintenance of DIMENSIONS.maintenance) {
              for (const scope of DIMENSIONS.scope) {
                for (const credential of DIMENSIONS.credential) {
                  for (const railState of DIMENSIONS.railState) {
                    allCases.push({
                      whitelist,
                      commission,
                      status,
                      health,
                      amountBand,
                      dailyCap,
                      maintenance,
                      scope,
                      credential,
                      railState,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

const stride = Math.max(1, Math.floor(allCases.length / 960));
const CASES = allCases.filter((_, index) => index % stride === 0).slice(0, 960);

const buildInput = (testCase: Case): VisibleRailsInput => {
  const whitelist = WHITELISTS[testCase.whitelist] ?? WHITELISTS[0]!;
  const rail: RailRecord = {
    id: "rail-sadad",
    code: "sadad",
    nameEn: "Sadad",
    currency: testCase.railState === "currency" ? "USD" : "LYD",
    blocked: testCase.railState === "blocked",
    displayOrder: 1,
    collectionMode: "OTP_PULL",
  };
  const amount = testCase.amountBand === "below" ? "5.0000" : testCase.amountBand === "above" ? "20000.0000" : "100.0000";
  const route: RailRouteRecord = {
    id: "route-1",
    railId: rail.id,
    gatewayId: "gateway-1",
    credentialPolicy: "PLATFORM",
    priority: 1,
    routingStrategy: "EFFECTIVE_COST",
    weight: 100,
    costModel: { flat: "1", percent: "0.5" },
    minAmount: "10.0000",
    maxAmount: "10000.0000",
    dailyCapAmount: testCase.dailyCap === "none" ? null : testCase.dailyCap === "exceeded" ? "50.0000" : "1000.0000",
    dailyProcessedAmount: testCase.dailyCap === "exceeded" ? "60.0000" : "10.0000",
    status: testCase.status,
    healthState: testCase.health,
    maintenanceWindows: testCase.maintenance === "inside"
      ? [{ start: new Date(NOW.getTime() - 60_000), end: new Date(NOW.getTime() + 60_000) }]
      : [],
    scope: testCase.scope === "in"
      ? { merchant_ids: ["merchant-1"], application_ids: ["app-1"], risk_tiers: ["LOW"], channels: ["WEB"] }
      : { merchant_ids: ["someone-else"] },
  };
  const credentialSets: CredentialSetRecord[] = [{
    id: "credential-1",
    gatewayId: "gateway-1",
    env: "LIVE",
    ownerType: "PLATFORM",
    ownerMerchantId: null,
    settlementTarget: "PLATFORM_CLEARING",
    status: testCase.credential,
  }];
  const commissionProfiles: CommissionProfileRecord[] = testCase.commission === "present"
    ? [{
      id: "commission-1",
      merchantId: "merchant-1",
      applicationId: "app-1",
      railCode: "sadad",
      effectiveFrom: new Date(NOW.getTime() - 86_400_000),
      status: "ACTIVE",
    }]
    : [];
  return {
    application: {
      id: "app-1",
      merchantId: "merchant-1",
      riskTier: "LOW",
      railWhitelist: whitelist.app,
    },
    link: {
      amount,
      currency: "LYD",
      railWhitelist: whitelist.link,
    },
    channel: "WEB",
    env: "LIVE",
    rails: [rail],
    routes: [route],
    credentialSets,
    commissionProfiles,
    now: NOW,
  };
};

const expectedOutcome = (testCase: Case): { visible: boolean; reason?: RouteExclusionReason } => {
  const whitelist = WHITELISTS[testCase.whitelist] ?? WHITELISTS[0]!;
  const allowed = whitelist.app === null
    ? whitelist.link
    : whitelist.link === null
      ? whitelist.app
      : whitelist.app.filter((code) => whitelist.link?.includes(code));
  if (testCase.railState === "blocked") return { visible: false, reason: "RAIL_BLOCKED" };
  if (testCase.railState === "currency") return { visible: false, reason: "CURRENCY_MISMATCH" };
  if (allowed !== null && !allowed.includes("sadad")) return { visible: false, reason: "RAIL_NOT_WHITELISTED" };
  if (testCase.commission === "missing") return { visible: false, reason: "NO_COMMISSION_PROFILE" };
  if (testCase.credential !== "VERIFIED") return { visible: false, reason: "NO_VERIFIED_CREDENTIAL_SET" };
  if (testCase.status !== "ACTIVE") return { visible: false, reason: "ROUTE_NOT_ACTIVE" };
  if (testCase.health !== "HEALTHY") return { visible: false, reason: "ROUTE_NOT_HEALTHY" };
  if (testCase.amountBand === "below") return { visible: false, reason: "AMOUNT_BELOW_MINIMUM" };
  if (testCase.amountBand === "above") return { visible: false, reason: "AMOUNT_ABOVE_MAXIMUM" };
  if (testCase.dailyCap === "exceeded") return { visible: false, reason: "DAILY_CAP_EXCEEDED" };
  if (testCase.maintenance === "inside") return { visible: false, reason: "MAINTENANCE_WINDOW" };
  if (testCase.scope === "out") return { visible: false, reason: "OUT_OF_SCOPE" };
  return { visible: true };
};

describe("Suite 04 · Visible Rails Formula matrix", () => {
  test(`the sampled formula matrix covers ${CASES.length} permutations`, () => {
    expect(CASES.length).toBe(960);
  });

  for (const [index, testCase] of CASES.entries()) {
    test(`formula #${index + 1} · w=${testCase.whitelist} c=${testCase.commission} s=${testCase.status} h=${testCase.health} a=${testCase.amountBand} cap=${testCase.dailyCap} am=${testCase.maintenance} scope=${testCase.scope} cred=${testCase.credential} rail=${testCase.railState}`, () => {
      const result = resolver.resolve(buildInput(testCase));
      const expected = expectedOutcome(testCase);
      if (expected.visible) {
        expect(result.rails).toHaveLength(1);
        expect(result.rails[0]?.rail.code).toBe("sadad");
        expect(result.rails[0]?.commissionProfile.id).toBe("commission-1");
        expect(result.rails[0]?.routes[0]?.rank).toBe(1);
        expect(result.excluded).toHaveLength(0);
      } else {
        expect(result.rails).toHaveLength(0);
        expect(result.excluded.map((entry) => entry.reason)).toContain(expected.reason as RouteExclusionReason);
      }
    });
  }
});
