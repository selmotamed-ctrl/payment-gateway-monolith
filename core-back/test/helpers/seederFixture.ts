import type { SeederConfig, ProfileVolumes } from "../../prisma/syntheticSeeder/config";
import { buildContext, type SeedReferences, type SeederContext } from "../../prisma/syntheticSeeder/context";
import { generateAdminAndStaff } from "../../prisma/syntheticSeeder/generators/01_adminAndStaffGenerator";
import { generateMerchantCohort } from "../../prisma/syntheticSeeder/generators/02_merchantCohortGenerator";
import { generateGatewayLifecycle, generateRouteHealth } from "../../prisma/syntheticSeeder/generators/03_gatewayLifecycleGenerator";
import { generateLinksAndAttempts } from "../../prisma/syntheticSeeder/generators/04_linksAndAttemptsGenerator";
import { generateCheckpoints, generateLedger } from "../../prisma/syntheticSeeder/generators/05_ledgerAndCheckpoints";
import { generateReconciliation } from "../../prisma/syntheticSeeder/generators/06_reconAndStatements";
import { generateDisputesCashoutsAdjustments } from "../../prisma/syntheticSeeder/generators/07_disputesCashoutsAdjustments";
import { generateAmlAndGovernanceQueues } from "../../prisma/syntheticSeeder/generators/08_amlAndGovernanceQueues";
import { generateOperatorCases } from "../../prisma/syntheticSeeder/generators/09_operatorCasesGenerator";

export const NOW = new Date("2026-11-04T12:00:00.000Z");

export const smallVolumes = (overrides: Partial<ProfileVolumes> = {}): ProfileVolumes => ({
  merchants: 30, joinRequests: 40, kybDocuments: 200, beneficialOwners: 60, users: 100, wallets: 45, applications: 60,
  paymentLinks: 700, paymentAttempts: 1500, reconciliationRuns: 20, reconciliationItems: 600, disputes: 25, adjustments: 60,
  cashouts: 40, amlScreenings: 90, amlCases: 25, operatorCases: 80, approvalRequests: 40, yearsSpan: 1.5, ...overrides,
});

const gl = (id: number, accountType: string) => ({ id: `gl-${id}`, accountType, gatewayId: null, env: null, ownerId: null, credentialSetId: null, currency: "LYD" });
const uuid = (n: number) => `ffffffff-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** A baseline-seed lookalike: 4 gateways, 4 rails, 5 routes, platform credentials, system GL accounts. */
export const baselineRefs = (): SeedReferences => {
  const gateways = [
    { id: uuid(1), code: "edfali", kind: "DIRECT", activeVersionId: uuid(11) },
    { id: uuid(2), code: "moamalat", kind: "DIRECT", activeVersionId: uuid(12) },
    { id: uuid(3), code: "neompay", kind: "INTERNAL", activeVersionId: uuid(13) },
    { id: uuid(4), code: "plutu", kind: "AGGREGATOR", activeVersionId: uuid(14) },
  ];
  const rails = [
    { id: uuid(21), code: "edfali", collectionMode: "OTP_PULL" },
    { id: uuid(22), code: "moamalat", collectionMode: "REDIRECT" },
    { id: uuid(23), code: "neompay", collectionMode: "PUSH_APPROVAL" },
    { id: uuid(24), code: "ly_pay", collectionMode: "QR_DISPLAY" },
  ];
  const cost = (percent: string, accrue: boolean) => ({ calc_type: "PERCENTAGE", flat: "0.0000", percent, min: "0.1000", max: "25.0000", accrue_fee_at_confirm: accrue });
  const route = (n: number, rail: number, gateway: number, percent: string, accrue: boolean) => ({
    id: uuid(30 + n), railId: rails[rail]!.id, railCode: rails[rail]!.code, gatewayId: gateways[gateway]!.id, gatewayCode: gateways[gateway]!.code,
    credentialPolicy: "PLATFORM", costModel: cost(percent, accrue), status: "ACTIVE", healthState: "HEALTHY", minAmount: "0.0000", maxAmount: null,
  });
  const credentials = gateways.flatMap((gateway, index) =>
    (["SANDBOX", "LIVE"] as const).map((env, envIndex) => ({
      id: uuid(40 + index * 2 + envIndex), gatewayId: gateway.id, gatewayCode: gateway.code, env, ownerType: "PLATFORM",
      settlementTarget: gateway.code === "plutu" ? "PROVIDER_HELD" : "PLATFORM_CLEARING", ownerMerchantId: null, status: "VERIFIED",
    })));
  const types = ["TREASURY", "GATEWAY_CLEARING", "PLATFORM_INCOME", "PROVIDER_FEE_EXPENSE", "GATEWAY_FEE_EXPENSE", "GATEWAY_FEE_ACCRUAL", "COMMISSION_RECEIVABLE", "AML_HOLD", "CHARGEBACK_RESERVE", "SUSPENSE"];
  const refs = {
    gateways,
    versions: gateways.map((gateway, index) => ({ id: uuid(11 + index), gatewayId: gateway.id, gatewayCode: gateway.code, versionNumber: 1, state: "LIVE", environments: [] })),
    rails,
    routes: [route(1, 0, 0, "1.2000", true), route(2, 0, 3, "1.5000", false), route(3, 1, 1, "1.8000", true), route(4, 2, 2, "0.0000", false), route(5, 3, 0, "1.0000", true)],
    credentials,
    glAccounts: types.map((type, index) => gl(index + 1, type)),
    adminUsers: [],
    statementSources: [],
    commissionProfiles: [{
      id: "cp-default", merchantId: null, applicationId: null, railCode: "default", calcType: "PERCENTAGE", flatFee: "0.0000", percentageRate: "0.030000",
      tiersJson: null, minFee: "0.0000", maxFee: null, effectiveFrom: new Date("2026-01-01T00:00:00Z"), effectiveTo: null,
    }],
    notificationTemplates: ["PAYMENT_SUCCEEDED", "PAYMENT_FAILED", "DISPUTE_OPENED", "CASHOUT_REQUESTED", "APPROVAL_REQUIRED"].flatMap((code) =>
      (["AR", "EN"] as const).map((lang) => ({ code, channel: "EMAIL", lang }))),
    requiredDocumentsSetting: null,
    confirmationChannels: [] as Array<{ id: string; gatewayVersionId: string; type: string }>,
  };
  // The real baseline seed (Fake Rails blueprints) already owns webhook channels for some gateway
  // versions; the generator only adds channels where one is missing. Mirror that split so events
  // that point at baseline channels are exercised by the DB-free audit too.
  refs.confirmationChannels = refs.versions.slice(0, 2).map((version, index) => ({
    id: uuid(90 + index),
    gatewayVersionId: version.id,
    type: "WEBHOOK",
  }));
  return refs;
};

export const buildFixtureContext = (seedKey = "fixture", volumes: Partial<ProfileVolumes> = {}, namespace = "synthv1"): SeederContext => {
  const config: SeederConfig = { profile: "COMPACT", seedKey, namespace, volumes: smallVolumes(volumes), now: NOW };
  return buildContext({} as never, config, baselineRefs());
};

export const runAllGenerators = (ctx: SeederContext): SeederContext => {
  generateAdminAndStaff(ctx);
  generateMerchantCohort(ctx);
  generateGatewayLifecycle(ctx);
  generateLinksAndAttempts(ctx);
  generateRouteHealth(ctx);
  generateLedger(ctx);
  generateReconciliation(ctx);
  generateDisputesCashoutsAdjustments(ctx);
  generateAmlAndGovernanceQueues(ctx);
  generateOperatorCases(ctx);
  generateCheckpoints(ctx);
  return ctx;
};
