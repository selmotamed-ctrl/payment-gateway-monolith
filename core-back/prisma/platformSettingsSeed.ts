/* Platform-setting defaults and decision-register records.
 *
 * This module has no side effects so the registry-coverage test can import
 * it. `prisma/seed.ts` applies the rows idempotently.
 *
 * Adding a setting? Follow `docs/developer/platform-settings.md`.
 */
export const platformSettings = [
  {
    key: "OD-1",
    valueJson: {
      mode: "PROVISIONAL",
      internalOnly: true,
      description: "CBL reporting thresholds remain provisional until written instructions are recorded.",
    },
  },
  {
    key: "OD-2",
    valueJson: {
      policy: "RISK_BASED",
      description: "Join request four-eyes decisions are selected by risk assessment.",
    },
  },
  {
    key: "OD-3",
    valueJson: {
      provider: "INTERNAL_WATCHLIST",
      adapters: ["internal-watchlist", "mock-sandbox"],
      description: "Screening is provider-driven and ships with internal and sandbox adapters.",
    },
  },
  {
    key: "OD-4",
    valueJson: {
      kybYears: 5,
      description: "KYB and related records are retained for five years by default.",
    },
  },
  {
    key: "OD-5",
    valueJson: {
      gatewayCode: "neompay",
      kind: "INTERNAL",
      recommendedStage: 2,
      description: "NeomPay is the recommended first production internal rail.",
    },
  },
  {
    key: "OD-6",
    valueJson: {
      ownerThresholdPercent: 25,
      description: "Beneficial owners at or above twenty-five percent are captured.",
    },
  },
  {
    key: "OD-7",
    valueJson: {
      otpPullSeconds: 1200,
      redirectSeconds: 1800,
      qrDisplaySeconds: 900,
      pushApprovalSeconds: 900,
      description: "Platform TTL ceilings for payment collection modes.",
    },
  },
  {
    key: "OD-8",
    valueJson: {
      negativeBalanceCeiling: "0.0000",
      currency: "LYD",
      description: "New merchants have no negative wallet balance allowance by default.",
    },
  },
  {
    key: "OD-9",
    valueJson: {
      ratificationWindowHours: 24,
      authorizedRoles: ["MLRO", "COMPLIANCE"],
      description: "Emergency suspensions require ratification by MLRO or a second compliance officer.",
    },
  },
  {
    key: "merchant_reports.policy",
    valueJson: {
      enabled: true,
      assetsEnabled: true,
      description: "Merchant report authoring and execution are enabled; merchant asset bundles are allowed up to the 2 MB limit.",
    },
  },
  {
    key: "route_health.policy",
    valueJson: {
      enabled: true,
      mode: "ENFORCE",
      sampleBucketSeconds: 300,
      windowSeconds: 900,
      minOutcomes: 10,
      degradeErrorRate: 0.3,
      openErrorRate: 0.6,
      degradeConsecutive: 3,
      openConsecutive: 6,
      recoverDegradedProbes: 2,
      recoverOpenProbes: 3,
      openCooldownSeconds: 300,
      probeIntervalSeconds: 60,
      probeBackoffMaxSeconds: 900,
      canaryPercent: 5,
      canaryMaxAmount: null,
      degradedRecoverMinOutcomes: 10,
      degradedRecoverErrorRate: 0.1,
      overrideDefaultExpiryDays: 7,
      overrideMaxExpiryDays: 30,
      overrideReviewHours: 24,
      description: "Automatic route health circuit breaker, degraded canary traffic and admin override limits.",
    },
  },
  {
    key: "OD-11",
    valueJson: {
      checkerRoles: ["MLRO", "COMPLIANCE", "FINANCE"],
      description: "Named organizational checker accounts are provisioned without embedded credentials.",
    },
  },
  {
    // The canonical key of the OD-2 policy: the design names the setting
    // `join_request.four_eyes_policy`, the decision register keys it as
    // `OD-2`. Both carry the same value, so the policy is the same
    // whichever key a deployment reads.
    key: "join_request.four_eyes_policy",
    valueJson: {
      policy: "RISK_BASED",
      ownerThresholdPercent: 25,
      description:
        "A second reviewer is required for a risky applicant: a high risk tier, a sanctions or PEP match, a controlling beneficial owner, an adverse media flag or a high risk business category.",
    },
  },
  {
    // The default KYB document set and the per-category additions. The
    // reviewer readiness panel and the expiry worker read the same setting.
    key: "onboarding.required_documents",
    valueJson: {
      default: ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE", "BANK_LETTER", "PROOF_OF_ADDRESS"],
      byCategory: {
        CRYPTO: ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE", "BANK_LETTER", "PROOF_OF_ADDRESS", "SECTOR_LICENSE"],
        GAMBLING: ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE", "BANK_LETTER", "PROOF_OF_ADDRESS", "SECTOR_LICENSE"],
        MONEY_TRANSMISSION: ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE", "BANK_LETTER", "PROOF_OF_ADDRESS", "SECTOR_LICENSE"],
        ARMS: ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE", "BANK_LETTER", "PROOF_OF_ADDRESS", "SECTOR_LICENSE"],
      },
      description: "Required KYB evidence; a category entry replaces the default list.",
    },
  },
  {
    key: "join_request.volume_threshold",
    valueJson: {
      amount: 250000,
      currency: "LYD",
      description: "An expected monthly volume above this amount forces a second reviewer.",
    },
  },
  {
    key: "kyb.refresh_policy",
    valueJson: {
      highMonths: 12,
      standardMonths: 24,
      lowMonths: 36,
      expiryGraceDays: 30,
      revalidationDueDays: 30,
      duplicateAmlThreshold: 3,
      description: "Periodic KYB re-verification cadence, expiry grace and duplicate-reuse AML threshold.",
    },
  },
  {
    // The internal watch list of the platform. The compliance team maintains
    // the entries; the version is what invalidates the cached screening
    // results, so a published revision always carries a new version.
    key: "screening.watchlist",
    valueJson: {
      version: "internal-v1",
      description: "The internal watch list the transaction hot path screens against.",
      entries: [],
    },
  },
  {
    // Safe defaults that make the runtime switches explicit and visible in
    // Platform Settings. The values match the code defaults, so seeding them
    // does not change behaviour.
    key: "screening.fail_closed",
    valueJson: {
      failClosed: true,
      description: "A screening error blocks the payment unless a documented emergency changes this switch.",
    },
  },
  {
    key: "SELF_PAYMENT_POLICY",
    valueJson: {
      policy: "BLOCK",
      description: "A merchant may not pay into its own wallet or account without a documented exception.",
    },
  },
  {
    key: "calendar.holidays",
    valueJson: {
      holidays: [],
      description: "Public holidays that pause business-hour SLA clocks. Weekends are Sunday to Thursday.",
    },
  },
] as const;
