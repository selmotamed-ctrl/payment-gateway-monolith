import type {
  AmlCaseRow,
  AmlRuleRow,
  AttemptWindowStats,
  MerchantRow,
  PaymentAttemptRow,
  PaymentLinkRow,
  PrismaLike,
  Repositories,
  Tx,
  VelocityRuleRow,
} from "../../engine/db/ports";
import { moneyFromDecimal, type Money } from "../../engine/db/money";
import { PrismaRepositories } from "../../engine/db/repositories";
import { createFakeRepositories } from "./fakeRepositories";

/**
 * The in-memory world of the attempt-creation guard.
 *
 * The guard is the transaction that reserves the slot of the link, so a test
 * of the guard needs a link, a merchant, the rules of the database and the
 * ledger accounts of the escrow. Everything is held in memory, so the tests
 * never need a live database.
 */
export interface GuardState {
  merchant: MerchantRow;
  link: PaymentLinkRow;
  /** The attempts that already exist, the window of a velocity rule sees them. */
  attempts: PaymentAttemptRow[];
  amlCases: AmlCaseRow[];
  velocityRules: VelocityRuleRow[];
  amlRules: AmlRuleRow[];
  journalEntries: Array<{ id: string; refType: string; refId: string; description: string }>;
  journalLines: Array<{ entryId: string; glAccountId: string; direction: string; amount: string }>;
  glAccounts: Array<{
    id: string;
    accountType: string;
    gatewayId: string | null;
    credentialSetId: string | null;
    env: string | null;
    currency: string;
  }>;
  /** The slot deltas the guard applied to the link. */
  slotDeltas: number[];
  /** The attempts the guard created. */
  createdAttempts: PaymentAttemptRow[];
  /** The patches the guard applied to an attempt. */
  attemptPatches: Array<{ id: string; patch: Record<string, unknown> }>;
  /** The platform settings the guard can read. */
  platformSettings: Record<string, unknown>;
  auditLogs: Array<{ action: string; entityType: string; entityId: string; afterJson?: unknown }>;
}

export const RAIL = {
  id: "rail-1",
  code: "edfali",
  collectionMode: "OTP_PULL",
};

export const ROUTE = {
  id: "route-1",
  gatewayId: "gateway-1",
};

export const CREDENTIAL_SET = {
  id: "credential-1",
  gatewayId: "gateway-1",
  env: "SANDBOX",
  settlementTarget: "PLATFORM_CLEARING",
};

export const GATEWAY = {
  id: "gateway-1",
  activeVersionId: "gateway-version-1",
};

export const COMMISSION_PROFILE = {
  id: "commission-1",
  railCode: "edfali",
};

export const merchantRow = (overrides: Partial<MerchantRow> = {}): MerchantRow => ({
  id: "merchant-1",
  legalName: "مؤسسة النور للتجارة",
  tradeName: null,
  taxId: null,
  registrationNo: null,
  businessCategory: null,
  status: "ACTIVE",
  kybStatus: "VERIFIED",
  riskTier: "STANDARD",
  onboardingChannel: "SELF_SERVICE",
  country: "LY",
  contactPhone: null,
  contactEmail: null,
  activatedAt: null,
  suspendedAt: null,
  suspensionReasonCode: null,
  negativeBalanceCeiling: 0,
  payoutBankDetailsJson: null,
  ...overrides,
});

export const linkRow = (overrides: Partial<PaymentLinkRow> = {}): PaymentLinkRow => ({
  id: "link-1",
  key: "link-key-1",
  applicationId: "application-1",
  walletId: "wallet-1",
  amount: "100.0000",
  currency: "LYD",
  feeBearer: "MERCHANT_ABSORBS",
  infiniteUse: false,
  useCount: 5,
  confirmedCount: 0,
  activeLockedCount: 0,
  state: "PENDING",
  expiresAt: null,
  railWhitelist: null,
  ...overrides,
});

export const velocityRule = (overrides: Partial<VelocityRuleRow> = {}): VelocityRuleRow => ({
  id: "velocity-1",
  scopeType: "MERCHANT",
  scopeValue: null,
  windowSeconds: 3600,
  maxCount: 3,
  maxAmount: null,
  action: "REJECT",
  active: true,
  version: 1,
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
  ...overrides,
});

export const amlRule = (overrides: Partial<AmlRuleRow> = {}): AmlRuleRow => ({
  id: "aml-rule-1",
  code: "LARGE_SINGLE_AMOUNT",
  name: "Large single amount",
  ruleType: "SINGLE_AMOUNT",
  scope: {},
  params: { min_amount: "50.0000", currency: "LYD" },
  action: "HOLD",
  baseSeverity: "HIGH",
  active: true,
  version: 1,
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
  ...overrides,
});

export const existingAttempt = (overrides: Partial<PaymentAttemptRow> = {}): PaymentAttemptRow => ({
  id: "attempt-existing-1",
  reference: "PA-EXISTING-1",
  idempotencyKey: null,
  linkId: "link-1",
  attemptGroupId: "group-1",
  applicationId: "application-1",
  merchantId: "merchant-1",
  railId: "rail-1",
  routeId: "route-1",
  credentialSetId: "credential-1",
  gatewayVersionId: "gateway-version-1",
  commissionProfileId: "commission-1",
  env: "SANDBOX",
  mode: "OTP_PULL",
  subMode: null,
  status: "SUCCEEDED",
  substatus: null,
  gatewayReference: null,
  providerReference: null,
  networkReference: null,
  requestedAmount: "100.0000",
  surchargeAmount: "0.0000",
  totalChargedAmount: "100.0000",
  settledAmount: "100.0000",
  gatewayFeeAmount: "0.0000",
  platformCommissionAmount: "3.0000",
  netMerchantAmount: "97.0000",
  feeBearer: "MERCHANT_ABSORBS",
  currency: "LYD",
  customerFieldsMasked: {},
  contextCiphertext: "",
  otpAttempts: 0,
  clientIp: null,
  expiresAt: null,
  graceExpiresAt: null,
  nextCheckAt: null,
  ledgerEntryId: null,
  terminalAt: null,
  createdAt: new Date("2026-03-01T11:30:00.000Z"),
  updatedAt: new Date("2026-03-01T11:30:00.000Z"),
  ...overrides,
});

const matchesJsonPath = (value: unknown, filter: { path: string[]; equals: unknown }): boolean => {
  let cursor: unknown = value;
  for (const segment of filter.path) {
    if (!cursor || typeof cursor !== "object") {
      return false;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor === filter.equals;
};

/**
 * The matcher of the `payment_attempt.findMany` filter of the guard.
 *
 * Only the filters the guard produces are supported: the window, the status
 * and the scope of the rule.
 */
const matchesAttemptFilter = (attempt: PaymentAttemptRow, where: Record<string, any>): boolean => {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "createdAt") {
      const since = (condition as { gte?: Date }).gte;
      const created = attempt.createdAt ?? new Date(0);
      if (since && created.getTime() < since.getTime()) {
        return false;
      }
      continue;
    }
    if (key === "status") {
      const statuses = (condition as { in?: string[] }).in ?? [];
      if (!statuses.includes(String(attempt.status))) {
        return false;
      }
      continue;
    }
    if (key === "OR") {
      const branches = (condition as Array<Record<string, any>>) ?? [];
      const matched = branches.some((branch) =>
        Object.entries(branch).every(
          ([field, value]) => attempt[field as keyof PaymentAttemptRow] === value,
        ),
      );
      if (!matched) {
        return false;
      }
      continue;
    }
    if (key === "customerFieldsMasked") {
      const filter = condition as { path: string[]; equals: unknown };
      if (!matchesJsonPath(attempt.customerFieldsMasked, filter)) {
        return false;
      }
      continue;
    }
    if (attempt[key as keyof PaymentAttemptRow] !== condition) {
      return false;
    }
  }
  return true;
};

const statsOf = (attempts: readonly PaymentAttemptRow[]): AttemptWindowStats => {
  const amounts: Money[] = [];
  let total = 0n;
  for (const attempt of attempts) {
    const value = moneyFromDecimal(attempt.totalChargedAmount ?? attempt.requestedAmount ?? 0);
    amounts.push(value);
    total += value;
  }
  return { count: amounts.length, totalAmount: total, amounts };
};

export interface GuardFixture {
  db: PrismaLike;
  repositories: Repositories;
  state: GuardState;
}

/**
 * Builds the in-memory world of the guard.
 */
export const createGuardFixture = (overrides: Partial<GuardState> = {}): GuardFixture => {
  const state: GuardState = {
    merchant: merchantRow(),
    link: linkRow(),
    attempts: [],
    amlCases: [],
    velocityRules: [],
    amlRules: [],
    journalEntries: [],
    journalLines: [],
    glAccounts: [
      {
        id: "gl-clearing",
        accountType: "GATEWAY_CLEARING",
        gatewayId: null,
        credentialSetId: null,
        env: null,
        currency: "LYD",
      },
      {
        id: "gl-aml-hold",
        accountType: "AML_HOLD",
        gatewayId: null,
        credentialSetId: null,
        env: null,
        currency: "LYD",
      },
    ],
    slotDeltas: [],
    createdAttempts: [],
    attemptPatches: [],
    platformSettings: {},
    auditLogs: [],
    ...overrides,
  };

  let sequence = 0;
  const nextId = (prefix: string): string => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };

  const tx = {
    rail: {
      findUnique: async ({ where }: { where: { code?: string; id?: string } }) =>
        where.code === RAIL.code || where.id === RAIL.id ? { ...RAIL } : null,
    },
    railRoute: {
      findMany: async () => [{ ...ROUTE }],
    },
    credentialSet: {
      findFirst: async () => ({ ...CREDENTIAL_SET }),
    },
    gateway: {
      findUnique: async () => ({ ...GATEWAY }),
    },
    commissionProfile: {
      findFirst: async () => ({ ...COMMISSION_PROFILE }),
    },
    attemptGroup: {
      upsert: async () => ({ id: "group-1" }),
    },
    paymentAttempt: {
      findMany: async ({ where }: { where: Record<string, any> }) =>
        state.attempts.filter((attempt) => matchesAttemptFilter(attempt, where)),
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.createdAttempts.find((attempt) => attempt.id === where.id) ?? null,
    },
    glAccount: {
      findFirst: async ({ where }: { where: Record<string, any> }) =>
        state.glAccounts.find((account) =>
          Object.entries(where).every(([key, value]) => (account as Record<string, unknown>)[key] === value),
        ) ?? null,
    },
    journalEntry: {
      findFirst: async ({ where }: { where: Record<string, any> }) =>
        state.journalEntries.find(
          (entry) =>
            entry.refType === where.refType && entry.refId === where.refId,
        ) ?? null,
      create: async ({ data }: { data: Record<string, any> }) => {
        const entry = {
          id: nextId("entry"),
          refType: String(data.refType),
          refId: String(data.refId),
          description: String(data.description ?? ""),
        };
        state.journalEntries.push(entry);
        return entry;
      },
    },
    journalLine: {
      create: async ({ data }: { data: Record<string, any> }) => {
        const amount = data.amount as { toFixed?: (places: number) => string } | string;
        const line = {
          entryId: String(data.entryId),
          glAccountId: String(data.glAccountId),
          direction: String(data.direction),
          amount:
            typeof amount === "string"
              ? amount
              : typeof amount?.toFixed === "function"
                ? amount.toFixed(4)
                : String(amount),
        };
        state.journalLines.push(line);
        return { id: nextId("line"), ...line };
      },
    },
  } as unknown as Record<string, unknown>;

  const db = {
    $transaction: async (callback: (inner: Tx) => Promise<unknown>) => callback(tx as unknown as Tx),
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    $queryRawUnsafe: async () => [],
    $executeRawUnsafe: async () => 0,
    ...tx,
  } as unknown as PrismaLike;

  const repositories = createFakeRepositories({
    merchants: {
      findMerchantById: async (_tx: Tx, id: string) => (id === state.merchant.id ? state.merchant : null),
      findMerchantByApplication: async (_tx: Tx, applicationId: string) =>
        applicationId === state.link.applicationId ? state.merchant : null,
    },
    payments: {
      lockLinkByKey: async (_tx: Tx, key: string) => (key === state.link.key ? state.link : null),
      findAttemptByIdempotencyKey: async () => null,
      resolveSettlementTarget: async () => "PLATFORM_CLEARING",
      updateLinkSlotCount: async (_tx: Tx, _linkId: string, delta: number) => {
        state.slotDeltas.push(delta);
      },
      createAttempt: async (_tx: Tx, data: Record<string, unknown>) => {
        const attempt = {
          id: nextId("attempt"),
          reference: String(data.reference ?? ""),
          idempotencyKey: (data.idempotencyKey as string | null) ?? null,
          linkId: String(data.linkId ?? ""),
          attemptGroupId: String(data.attemptGroupId ?? ""),
          applicationId: String(data.applicationId ?? ""),
          merchantId: String(data.merchantId ?? ""),
          railId: String(data.railId ?? ""),
          routeId: String(data.routeId ?? ""),
          credentialSetId: String(data.credentialSetId ?? ""),
          gatewayVersionId: String(data.gatewayVersionId ?? ""),
          commissionProfileId: String(data.commissionProfileId ?? ""),
          env: String(data.env ?? "SANDBOX"),
          mode: String(data.mode ?? ""),
          subMode: (data.subMode as string | null) ?? null,
          status: String(data.status ?? "CREATED"),
          substatus: (data.substatus as string | null) ?? null,
          requestedAmount: data.requestedAmount ?? "0.0000",
          surchargeAmount: data.surchargeAmount ?? "0.0000",
          totalChargedAmount: data.totalChargedAmount ?? "0.0000",
          platformCommissionAmount: data.platformCommissionAmount ?? "0.0000",
          netMerchantAmount: data.netMerchantAmount ?? "0.0000",
          gatewayFeeAmount: data.gatewayFeeAmount ?? null,
          feeBearer: String(data.feeBearer ?? "MERCHANT_ABSORBS"),
          currency: String(data.currency ?? "LYD"),
          customerFieldsMasked: data.customerFieldsMasked ?? {},
          contextCiphertext: String(data.contextCiphertext ?? ""),
          clientIp: (data.clientIp as string | null) ?? null,
          expiresAt: (data.expiresAt as Date | null) ?? null,
          graceExpiresAt: (data.graceExpiresAt as Date | null) ?? null,
          nextCheckAt: (data.nextCheckAt as Date | null) ?? null,
          terminalAt: (data.terminalAt as Date | null) ?? null,
          ...(data.settlementTarget ? { settlementTarget: data.settlementTarget } : {}),
        } as unknown as PaymentAttemptRow;
        state.createdAttempts.push(attempt);
        return attempt;
      },
      updateAttempt: async (_tx: Tx, id: string, patch: Record<string, unknown>) => {
        state.attemptPatches.push({ id, patch });
        const attempt = state.createdAttempts.find((entry) => entry.id === id);
        if (attempt) {
          Object.assign(attempt, patch);
        }
        return attempt ?? ({} as PaymentAttemptRow);
      },
      collectWindowStats: async () => statsOf(state.attempts),
    },
    risk: {
      listActiveVelocityRules: async () => state.velocityRules,
      listActiveAmlRules: async () => state.amlRules,
      countOpenAmlCases: async () => 0,
      createAmlCase: async (_tx: Tx, data: Record<string, unknown>) => {
        const row = {
          id: nextId("case"),
          subjectType: String(data.subjectType ?? "PAYMENT_ATTEMPT"),
          subjectId: String(data.subjectId ?? ""),
          triggerReason: String(data.triggerReason ?? ""),
          severity: String(data.severity ?? "MEDIUM"),
          severityInputsJson: data.severityInputsJson ?? [],
          screeningId: null,
          ruleId: null,
          ruleVersion: null,
          holdJournalEntryId: null,
          status: "OPEN",
          slaDueAt: null,
          assignedReviewerId: null,
          regulatoryReportId: null,
          confidential: true,
          reviewerNotes: null,
        } as unknown as AmlCaseRow;
        state.amlCases.push(row);
        return row;
      },
      updateAmlCase: async (_tx: Tx, id: string, patch: Record<string, unknown>) => {
        const row = state.amlCases.find((entry) => entry.id === id);
        if (row) {
          Object.assign(row, patch);
        }
        return row ?? ({} as AmlCaseRow);
      },
    },
    governance: {
      getPlatformSetting: async (_tx: Tx, key: string) => state.platformSettings[key] ?? null,
      writeAuditLog: async (
        _tx: Tx,
        data: { action: string; entityType: string; entityId: string; afterJson?: unknown },
      ) => {
        state.auditLogs.push({
          action: data.action,
          entityType: data.entityType,
          entityId: data.entityId,
          afterJson: data.afterJson,
        });
      },
    },
  });

  return { db, repositories, state };
};

/**
 * The same world, but read through the real Prisma repositories.
 *
 * The repositories are the production ones (`PrismaRepositories`), so a test
 * that uses this fixture proves that the rules, the window counters and the
 * ledger accounts are read from the database the way the guard reads them.
 */
export const createPrismaGuardFixture = (
  overrides: Partial<GuardState> = {},
): GuardFixture => {
  const state: GuardState = {
    merchant: merchantRow(),
    link: linkRow(),
    attempts: [],
    amlCases: [],
    velocityRules: [],
    amlRules: [],
    journalEntries: [],
    journalLines: [],
    glAccounts: [
      {
        id: "gl-clearing",
        accountType: "GATEWAY_CLEARING",
        gatewayId: null,
        credentialSetId: null,
        env: null,
        currency: "LYD",
      },
      {
        id: "gl-aml-hold",
        accountType: "AML_HOLD",
        gatewayId: null,
        credentialSetId: null,
        env: null,
        currency: "LYD",
      },
    ],
    slotDeltas: [],
    createdAttempts: [],
    attemptPatches: [],
    platformSettings: {},
    auditLogs: [],
    ...overrides,
  };

  let sequence = 0;
  const nextId = (prefix: string): string => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };

  const rawLink = () => ({
    id: state.link.id,
    key: state.link.key,
    application_id: state.link.applicationId,
    wallet_id: state.link.walletId,
    amount: state.link.amount,
    currency: state.link.currency,
    fee_bearer: state.link.feeBearer,
    infinite_use: state.link.infiniteUse,
    use_count: state.link.useCount,
    confirmed_count: state.link.confirmedCount,
    active_locked_count: state.link.activeLockedCount,
    state: state.link.state,
    expires_at: state.link.expiresAt,
    rail_whitelist: state.link.railWhitelist,
  });

  const tx = {
    paymentLink: {
      findUnique: async ({ where }: { where: { key?: string; id?: string } }) =>
        where.key === state.link.key || where.id === state.link.id ? state.link : null,
    },
    paymentAttempt: {
      findMany: async ({ where }: { where: Record<string, any> }) =>
        state.attempts.filter((attempt) => matchesAttemptFilter(attempt, where)),
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.createdAttempts.find((attempt) => attempt.id === where.id) ?? null,
      findFirst: async ({ where }: { where: Record<string, any> }) =>
        state.createdAttempts.find((attempt) =>
          Object.entries(where).every(
            ([key, value]) => (attempt as unknown as Record<string, unknown>)[key] === value,
          ),
        ) ?? null,
      create: async ({ data }: { data: Record<string, any> }) => {
        const attempt = {
          id: nextId("attempt"),
          reference: String(data.reference ?? ""),
          idempotencyKey: (data.idempotencyKey as string | null) ?? null,
          linkId: String(data.linkId ?? ""),
          attemptGroupId: String(data.attemptGroupId ?? ""),
          applicationId: String(data.applicationId ?? ""),
          merchantId: String(data.merchantId ?? ""),
          railId: String(data.railId ?? ""),
          routeId: String(data.routeId ?? ""),
          credentialSetId: String(data.credentialSetId ?? ""),
          gatewayVersionId: String(data.gatewayVersionId ?? ""),
          commissionProfileId: String(data.commissionProfileId ?? ""),
          env: String(data.env ?? "SANDBOX"),
          mode: String(data.mode ?? ""),
          subMode: (data.subMode as string | null) ?? null,
          status: String(data.status ?? "CREATED"),
          substatus: (data.substatus as string | null) ?? null,
          requestedAmount: data.requestedAmount ?? "0.0000",
          surchargeAmount: data.surchargeAmount ?? "0.0000",
          totalChargedAmount: data.totalChargedAmount ?? "0.0000",
          platformCommissionAmount: data.platformCommissionAmount ?? "0.0000",
          netMerchantAmount: data.netMerchantAmount ?? "0.0000",
          gatewayFeeAmount: data.gatewayFeeAmount ?? null,
          feeBearer: String(data.feeBearer ?? "MERCHANT_ABSORBS"),
          currency: String(data.currency ?? "LYD"),
          customerFieldsMasked: data.customerFieldsMasked ?? {},
          contextCiphertext: String(data.contextCiphertext ?? ""),
          clientIp: (data.clientIp as string | null) ?? null,
          expiresAt: (data.expiresAt as Date | null) ?? null,
          graceExpiresAt: (data.graceExpiresAt as Date | null) ?? null,
          nextCheckAt: (data.nextCheckAt as Date | null) ?? null,
          terminalAt: (data.terminalAt as Date | null) ?? null,
          ...(data.settlementTarget ? { settlementTarget: data.settlementTarget } : {}),
        } as unknown as PaymentAttemptRow;
        state.createdAttempts.push(attempt);
        return attempt;
      },
      update: async ({ where }: { where: { id: string } }) => {
        const attempt = state.createdAttempts.find((entry) => entry.id === where.id);
        return attempt ?? ({} as PaymentAttemptRow);
      },
    },
    merchant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === state.merchant.id ? state.merchant : null,
    },
    application: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === state.link.applicationId ? { merchantId: state.merchant.id } : null,
    },
    velocityRule: {
      findMany: async () => state.velocityRules,
    },
    amlRule: {
      findMany: async () => state.amlRules,
    },
    amlCase: {
      create: async ({ data }: { data: Record<string, any> }) => {
        const row = {
          id: nextId("case"),
          subjectType: String(data.subjectType ?? "PAYMENT_ATTEMPT"),
          subjectId: String(data.subjectId ?? ""),
          triggerReason: String(data.triggerReason ?? ""),
          severity: String(data.severity ?? "MEDIUM"),
          severityInputsJson: data.severityInputsJson ?? [],
          screeningId: null,
          ruleId: null,
          ruleVersion: null,
          holdJournalEntryId: null,
          status: "OPEN",
          slaDueAt: null,
          assignedReviewerId: null,
          regulatoryReportId: null,
          confidential: true,
          reviewerNotes: null,
        } as unknown as AmlCaseRow;
        state.amlCases.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.amlCases.find((entry) => entry.id === where.id);
        if (row) {
          Object.assign(row, data);
        }
        return row ?? ({} as AmlCaseRow);
      },
      count: async () => 0,
    },
    platformSetting: {
      findFirst: async ({ where }: { where: { key: string } }) => {
        const value = state.platformSettings[where.key];
        return value === undefined
          ? null
          : { id: `setting-${where.key}`, key: where.key, scope: "PLATFORM", valueJson: value, version: 1 };
      },
    },
    attemptGroup: {
      upsert: async () => ({ id: "group-1" }),
    },
    rail: {
      findUnique: async () => ({ ...RAIL }),
    },
    railRoute: {
      findMany: async () => [{ ...ROUTE }],
    },
    credentialSet: {
      findFirst: async () => ({ ...CREDENTIAL_SET }),
    },
    gateway: {
      findUnique: async () => ({ ...GATEWAY }),
    },
    commissionProfile: {
      findFirst: async () => ({ ...COMMISSION_PROFILE }),
    },
    glAccount: {
      findFirst: async ({ where }: { where: Record<string, any> }) =>
        state.glAccounts.find((account) =>
          Object.entries(where).every(
            ([key, value]) => (account as Record<string, unknown>)[key] === value,
          ),
        ) ?? null,
    },
    journalEntry: {
      findFirst: async ({ where }: { where: Record<string, any> }) =>
        state.journalEntries.find(
          (entry) => entry.refType === where.refType && entry.refId === where.refId,
        ) ?? null,
      create: async ({ data }: { data: Record<string, any> }) => {
        const entry = {
          id: nextId("entry"),
          refType: String(data.refType),
          refId: String(data.refId),
          description: String(data.description ?? ""),
        };
        state.journalEntries.push(entry);
        return entry;
      },
    },
    journalLine: {
      create: async ({ data }: { data: Record<string, any> }) => {
        const amount = data.amount as { toFixed?: (places: number) => string } | string;
        const line = {
          entryId: String(data.entryId),
          glAccountId: String(data.glAccountId),
          direction: String(data.direction),
          amount:
            typeof amount === "string"
              ? amount
              : typeof amount?.toFixed === "function"
                ? amount.toFixed(4)
                : String(amount),
        };
        state.journalLines.push(line);
        return { id: nextId("line"), ...line };
      },
    },
    $queryRaw: async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      const sql = typeof strings === "string" ? strings : strings.join("?");
      if (sql.includes("payment_links")) {
        return [rawLink()];
      }
      if (sql.includes("settlement_target")) {
        return [{ settlement_target: "PLATFORM_CLEARING" }];
      }
      void values;
      return [];
    },
    $executeRaw: async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      const sql = typeof strings === "string" ? strings : strings.join("?");
      if (sql.includes("active_locked_count")) {
        state.slotDeltas.push(Number(values[0] ?? 0));
      }
      return 1;
    },
    $queryRawUnsafe: async () => [],
    $executeRawUnsafe: async () => 0,
  } as unknown as Record<string, unknown>;

  const db = {
    ...tx,
    $transaction: async (callback: (inner: Tx) => Promise<unknown>) => callback(tx as unknown as Tx),
  } as unknown as PrismaLike;

  const repositories = new PrismaRepositories(db as never);

  return { db, repositories, state };
};
