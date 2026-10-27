import { beforeEach, describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import { PrismaRepositories } from "../engine/db/repositories";
import { LedgerPoster } from "../engine/ledger/LedgerPoster";
import {
  SYSTEM_AUTOMATION_USER_ID,
  decideCommissionReceivableCeiling,
  evaluateCommissionReceivableCeiling,
  executeApprovalSubject,
  openDisputeWithDraftedAdjustment,
  type GovernanceExecutionContext,
  type RefundExecutionEngine,
} from "../engine/governance/GovernanceExecution";
import { createReconciliationJobHandler } from "../engine/workers/BackgroundJobHandlers";
import { MOCK_SCENARIOS } from "../engine/mockGateway/MockGatewayServer";
import {
  createFakePrisma as createGovernanceFake,
  fakeTable as governanceTable,
  resetFakeDatabase as resetGovernanceDatabase,
  type FakePrisma,
  type FakeRow,
} from "./helpers/governanceFake";
import {
  createFakePrisma as createJobFake,
  fakeTable as jobTable,
  resetFakeDatabase as resetJobDatabase,
} from "./helpers/backgroundJobFake";

let sequence = 0;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const matchesWhere = (row: FakeRow, where: Record<string, unknown>): boolean => {
  for (const [key, expected] of Object.entries(where ?? {})) {
    if (expected === undefined) {
      continue;
    }
    if (key === "OR" && Array.isArray(expected)) {
      if (!expected.some((alternative) => matchesWhere(row, alternative as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (key === "AND" && Array.isArray(expected)) {
      if (!expected.every((alternative) => matchesWhere(row, alternative as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (isPlainObject(expected)) {
      if (Array.isArray(expected.in)) {
        if (!expected.in.includes(row[key])) {
          return false;
        }
        continue;
      }
      if ("not" in expected) {
        if (row[key] === expected.not) {
          return false;
        }
        continue;
      }
    }
    if (row[key] !== expected) {
      return false;
    }
  }
  return true;
};

const genericModel = (name: string) => {
  const rows = (): FakeRow[] => governanceTable(name);
  const find = (where: Record<string, unknown>): FakeRow | undefined =>
    rows().find((row) => matchesWhere(row, where));
  return {
    async findUnique(args: { where: Record<string, unknown> }): Promise<FakeRow | null> {
      return find(args.where) ?? null;
    },
    async findFirst(args: { where: Record<string, unknown> }): Promise<FakeRow | null> {
      return find(args.where) ?? null;
    },
    async findMany(args: { where?: Record<string, unknown> } = {}): Promise<FakeRow[]> {
      return args.where ? rows().filter((row) => matchesWhere(row, args.where ?? {})) : [...rows()];
    },
    async create(args: { data: FakeRow }): Promise<FakeRow> {
      sequence += 1;
      const row: FakeRow = { id: `generic-${name}-${sequence}`, ...args.data };
      rows().push(row);
      return row;
    },
    async update(args: { where: Record<string, unknown>; data: FakeRow }): Promise<FakeRow> {
      const row = find(args.where);
      if (!row) {
        throw new Error(`Fake '${name}' row not found`);
      }
      Object.assign(row, args.data);
      return row;
    },
    async updateMany(args: { where: Record<string, unknown>; data: FakeRow }): Promise<{ count: number }> {
      let count = 0;
      for (const row of rows()) {
        if (matchesWhere(row, args.where)) {
          Object.assign(row, args.data);
          count += 1;
        }
      }
      return { count };
    },
    async deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> {
      const remaining = rows().filter((row) => !matchesWhere(row, args.where));
      const count = rows().length - remaining.length;
      rows().splice(0, rows().length, ...remaining);
      return { count };
    },
  };
};

const extendFake = (base: FakePrisma): FakePrisma => {
  const cache = new Map<string, unknown>();
  const baseTransaction = (base as { $transaction: <R>(callback: (tx: FakePrisma) => Promise<R>) => Promise<R> })
    .$transaction.bind(base);
  const proxy: Record<string, unknown> = new Proxy(base as unknown as Record<string, unknown>, {
    get(target, property) {
      if (property === "$transaction") {
        return async <R>(callback: (tx: FakePrisma) => Promise<R>): Promise<R> =>
          baseTransaction(async () => callback(proxy as unknown as FakePrisma));
      }
      if (property in target) {
        return target[property as keyof typeof target];
      }
      if (typeof property !== "string") {
        return undefined;
      }
      if (!cache.has(property)) {
        cache.set(property, genericModel(property));
      }
      return cache.get(property);
    },
  });
  return proxy as unknown as FakePrisma;
};

interface Fixture {
  client: FakePrisma;
  context: GovernanceExecutionContext;
}

const buildFixture = (): Fixture => {
  resetGovernanceDatabase();
  const client = extendFake(createGovernanceFake());
  const repositories = new PrismaRepositories(client as never);
  const ledgerPoster = new LedgerPoster(client as never);

  for (const [id, accountType, extra] of [
    ["acc-treasury", "TREASURY", {}],
    ["acc-clearing", "GATEWAY_CLEARING", { gatewayId: "gateway-1" }],
    ["acc-wallet", "MERCHANT_WALLET", { ownerId: "merchant-1" }],
    ["acc-income", "PLATFORM_INCOME", {}],
    ["acc-chargeback", "CHARGEBACK_RESERVE", {}],
    ["acc-accrual", "GATEWAY_FEE_ACCRUAL", {}],
  ] as const) {
    client.glAccount.create({
      data: { id, accountType, currency: "LYD", ...extra },
    });
  }

  client.user.create({
    data: {
      id: "user-maker",
      email: "maker@payment-gateway.internal",
      role: "COMPLIANCE",
      authoritiesMap: {},
      isMaker: true,
      isChecker: false,
      status: "ACTIVE",
    },
  });
  client.user.create({
    data: {
      id: "user-checker",
      email: "checker@payment-gateway.internal",
      role: "MLRO",
      authoritiesMap: {},
      isMaker: false,
      isChecker: true,
      status: "ACTIVE",
    },
  });
  client.user.create({
    data: {
      id: "user-finance",
      email: "finance@payment-gateway.internal",
      role: "FINANCE",
      authoritiesMap: {},
      isMaker: false,
      isChecker: true,
      status: "ACTIVE",
    },
  });
  client.merchant.create({
    data: {
      id: "merchant-1",
      legalName: "Merchant One",
      tradeName: "Merchant One",
      status: "ACTIVE",
      kybStatus: "VERIFIED",
      riskTier: "STANDARD",
      onboardingChannel: "DIRECT",
      country: "LY",
      negativeBalanceCeiling: new Decimal(0),
      activatedAt: new Date(),
    },
  });
  client.wallet.create({
    data: { id: "wallet-1", merchantId: "merchant-1", glAccountId: "acc-wallet", currency: "LYD", status: "ACTIVE" },
  });
  client.paymentAttempt.create({
    data: {
      id: "attempt-1",
      reference: "PA-0001",
      merchantId: "merchant-1",
      applicationId: "app-1",
      gatewayVersionId: "version-1",
      currency: "LYD",
      env: "LIVE",
      status: "SUCCEEDED",
      totalChargedAmount: new Decimal(100),
      platformCommissionAmount: new Decimal(3),
      netMerchantAmount: new Decimal(97),
      settlementTarget: "PLATFORM_CLEARING",
    },
  });
  client.journalEntry.create({
    data: { id: "settlement-entry", refType: "PAYMENT_ATTEMPT", refId: "attempt-0", description: "Settled payment" },
  });
  client.journalLine.create({
    data: {
      id: "settlement-line",
      entryId: "settlement-entry",
      glAccountId: "acc-wallet",
      direction: "CREDIT",
      amount: new Decimal(1000),
    },
  });

  return { client, context: { ledgerPoster, repositories } };
};

const runApproval = async (
  fixture: Fixture,
  input: {
    subjectType: string;
    subjectId: string;
    payloadDiffJson?: unknown;
    makerUserId?: string;
    checkerUserId?: string;
    checkerRole?: string;
    outcome?: "WON" | "LOST";
    approvalId?: string;
  },
) => {
  const approval = await fixture.client.approvalRequest.create({
    data: {
      id: input.approvalId ?? "approval-1",
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payloadDiffJson: input.payloadDiffJson ?? {},
      mode: "STANDARD",
      makerUserId: input.makerUserId ?? "user-maker",
      state: "PENDING_REVIEW",
    },
  });
  return fixture.client.$transaction(async (tx) =>
    executeApprovalSubject(fixture.context, tx as never, {
      approval: {
        id: String(approval.id),
        subjectType: approval.subjectType,
        subjectId: approval.subjectId,
        payloadDiffJson: approval.payloadDiffJson,
        makerUserId: approval.makerUserId,
      },
      checkerUserId: input.checkerUserId ?? "user-checker",
      checkerRole: input.checkerRole ?? "MLRO",
      outcome: input.outcome ?? null,
    }),
  );
};

const entryOf = (refType: string, refId: string): FakeRow | undefined =>
  governanceTable("journalEntry").find((row) => row.refType === refType && row.refId === refId);

const linesOf = (entryId: string): FakeRow[] =>
  governanceTable("journalLine").filter((row) => row.entryId === entryId);

const amountOf = (row: FakeRow): string => new Decimal(String(row.amount)).toFixed(4);

describe("F4: actionable approval subjects", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  test("JOIN_REQUEST activates the merchant and its wallet", async () => {
    await fixture.client.merchant.update({
      where: { id: "merchant-1" },
      data: { status: "PENDING", kybStatus: "UNVERIFIED", activatedAt: null },
    });
    await fixture.client.wallet.update({ where: { id: "wallet-1" }, data: { status: "PENDING" } });
    await fixture.client.joinRequest.create({
      data: {
        id: "join-1",
        merchantId: "merchant-1",
        submittedByUserId: "user-maker",
        status: "PENDING_CHECKER",
        onboardingChannel: "SELF_SERVICE",
        slaDueAt: new Date(),
        proposedRiskTier: "STANDARD",
        fourEyesRequired: true,
      },
    });

    const result = await runApproval(fixture, {
      subjectType: "JOIN_REQUEST",
      subjectId: "join-1",
      payloadDiffJson: { decision: "APPROVED", reasonCode: "KYB_OK", notes: "all checks passed" },
    });

    expect(result.status).toBe("EXECUTED");
    const joinRequest = governanceTable("joinRequest").find((row) => row.id === "join-1");
    expect(joinRequest?.status).toBe("APPROVED");
    expect(joinRequest?.decision).toBe("APPROVED");
    const merchant = governanceTable("merchant").find((row) => row.id === "merchant-1");
    expect(merchant?.status).toBe("ACTIVE");
    expect(merchant?.kybStatus).toBe("VERIFIED");
    expect(merchant?.activatedAt).toBeInstanceOf(Date);
    expect(governanceTable("wallet")[0]?.status).toBe("ACTIVE");
    const audit = governanceTable("auditLog").find((row) => row.action === "JOIN_REQUEST_APPROVED");
    expect(audit).toBeDefined();
  });

  test("MERCHANT applies the JSON patch and records the detail change", async () => {
    const result = await runApproval(fixture, {
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      payloadDiffJson: [{ op: "replace", path: "/tradeName", value: "Merchant Two" }],
    });

    expect(result.status).toBe("EXECUTED");
    const merchant = governanceTable("merchant").find((row) => row.id === "merchant-1");
    expect(merchant?.tradeName).toBe("Merchant Two");
    const detail = governanceTable("detailChangeLog").find((row) => row.fieldName === "/tradeName");
    expect(detail?.oldValue).toBe("Merchant One");
    expect(detail?.newValue).toBe("Merchant Two");
    expect(governanceTable("auditLog").some((row) => row.action === "MERCHANT_EDIT_APPLIED")).toBe(true);
  });

  test("USER applies the pending authorities and role change", async () => {
    await fixture.client.user.create({
      data: {
        id: "user-target",
        email: "target@payment-gateway.internal",
        role: "SUPPORT",
        authoritiesMap: ["user:read"],
        isMaker: false,
        isChecker: false,
        status: "ACTIVE",
      },
    });

    const result = await runApproval(fixture, {
      subjectType: "USER",
      subjectId: "user-target",
      payloadDiffJson: { authoritiesMap: ["merchant:read", "merchant:write"], role: "OPERATOR" },
    });

    expect(result.status).toBe("EXECUTED");
    const user = governanceTable("user").find((row) => row.id === "user-target");
    expect(user?.role).toBe("OPERATOR");
    expect(user?.authoritiesMap).toEqual(["merchant:read", "merchant:write"]);
    expect(governanceTable("auditLog").some((row) => row.action === "USER_AUTHORITY_UPDATED")).toBe(true);
  });

  test("GATEWAY_VERSION passes the gates and goes live inside the approval transaction", async () => {
    fixture.client.gateway.create({
      data: { id: "gateway-1", code: "test_gw", status: "LIVE", activeVersionId: "version-0" },
    });
    fixture.client.gatewayVersion.create({
      data: {
        id: "version-0",
        gatewayId: "gateway-1",
        createdById: "user-maker",
        state: "LIVE",
        versionNumber: 0,
      },
    });
    fixture.client.gatewayVersion.create({
      data: {
        id: "version-1",
        gatewayId: "gateway-1",
        createdById: "user-maker",
        state: "PENDING_APPROVAL",
        versionNumber: 1,
        rollbackVersionId: "version-0",
      },
    });
    fixture.client.gatewayVersionEvidence.create({
      data: {
        gatewayVersionId: "version-1",
        evidenceJson: {
          scenarioResults: MOCK_SCENARIOS.map((scenario) => ({ scenario, passed: true })),
          amountPipelineContractPassed: true,
          referenceFormatContractPassed: true,
          cryptographicSignatureContractPassed: true,
          channels: [{ type: "WEBHOOK", verificationMethod: "HMAC_BODY", mustInquire: false }],
          rollbackVersionId: "version-0",
          routeLimitsPreviewed: true,
          commissionProfilePreviewed: true,
          statementParserPreviewed: true,
          evidenceLevel: "VERIFIED",
          internalContractSuitePassed: true,
          highRiskExecutiveAcceptanceSigned: false,
          panFieldCount: 0,
          pciScopeReviewPassed: false,
          canaryTrafficPlanConfigured: true,
          routeAlertsConfigured: true,
          runbooksConfigured: true,
          contractDetails: {},
        },
      },
    });

    const result = await runApproval(fixture, {
      subjectType: "GATEWAY_VERSION",
      subjectId: "version-1",
      payloadDiffJson: {},
    });

    expect(result.status).toBe("EXECUTED");
    expect(governanceTable("gatewayVersion").find((row) => row.id === "version-1")?.state).toBe("LIVE");
    expect(governanceTable("gatewayVersion").find((row) => row.id === "version-0")?.state).toBe("SUPERSEDED");
    const gateway = governanceTable("gateway").find((row) => row.id === "gateway-1");
    expect(gateway?.activeVersionId).toBe("version-1");
    expect(gateway?.status).toBe("LIVE");
  });

  test("an unknown subject is an explicit error instead of a silent approval", async () => {
    await expect(
      runApproval(fixture, {
        subjectType: "PLATFORM_SETTING",
        subjectId: "setting-1",
        payloadDiffJson: {},
      }),
    ).rejects.toThrow(/no executable handler/i);
  });
});

describe("F3: an approved refund calls the gateway before it books", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
    fixture.client.adjustment.create({
      data: {
        id: "refund-1",
        type: "REFUND",
        targetGlAccountId: "acc-wallet",
        sourceAttemptId: "attempt-1",
        amount: new Decimal(100),
        reverseCommission: true,
        reason: "Customer requested a refund",
        draftedBySystem: false,
        state: "PENDING_REVIEW",
      },
    });
  });

  test("the successful gateway refund posts the refund entry once", async () => {
    const calls: Array<{ adjustmentId: string; amount: string }> = [];
    const engine: RefundExecutionEngine = {
      refund: async (_attempt, amount, adjustmentId) => {
        calls.push({ adjustmentId, amount: amount.toFixed(4) });
        return { status: "REFUNDED", attempt: { ownershipMode: "PLATFORM_CLEARING" } };
      },
    };
    fixture.context.engine = engine;

    const result = await runApproval(fixture, {
      subjectType: "ADJUSTMENT",
      subjectId: "refund-1",
      payloadDiffJson: { type: "REFUND" },
      checkerUserId: "user-finance",
      checkerRole: "FINANCE",
    });

    expect(result.status).toBe("EXECUTED");
    expect(calls).toEqual([{ adjustmentId: "refund-1", amount: "100.0000" }]);
    const entry = entryOf("ADJUSTMENT", "refund-1");
    expect(entry).toBeDefined();
    const byAccount = new Map(linesOf(String(entry?.id)).map((row) => [String(row.glAccountId), row]));
    expect(String(byAccount.get("acc-wallet")?.direction)).toBe("DEBIT");
    expect(amountOf(byAccount.get("acc-wallet")!)).toBe("97.0000");
    expect(amountOf(byAccount.get("acc-income")!)).toBe("3.0000");
    expect(String(byAccount.get("acc-treasury")?.direction)).toBe("CREDIT");
    expect(amountOf(byAccount.get("acc-treasury")!)).toBe("100.0000");
    const adjustment = governanceTable("adjustment").find((row) => row.id === "refund-1");
    expect(adjustment?.state).toBe("EXECUTED");
    expect(adjustment?.journalEntryId).toBe(String(entry?.id));
  });

  test("an UNKNOWN gateway answer leaves the adjustment EXECUTING and posts nothing", async () => {
    const scheduled: Array<{ attemptId: string; adjustmentId?: string }> = [];
    fixture.context.engine = {
      refund: async () => ({ status: "UNKNOWN" }),
    };
    fixture.context.reconciliationScheduler = {
      schedule: (attemptId, adjustmentId) => {
        scheduled.push({ attemptId, adjustmentId });
      },
    };

    const result = await runApproval(fixture, {
      subjectType: "ADJUSTMENT",
      subjectId: "refund-1",
      payloadDiffJson: { type: "REFUND" },
      checkerUserId: "user-finance",
      checkerRole: "FINANCE",
    });

    expect(result.status).toBe("HELD");
    expect(result.reason).toBe("REFUND_GATEWAY_UNKNOWN");
    const adjustment = governanceTable("adjustment").find((row) => row.id === "refund-1");
    expect(adjustment?.state).toBe("EXECUTING");
    expect(entryOf("ADJUSTMENT", "refund-1")).toBeUndefined();
    expect(scheduled).toEqual([{ attemptId: "attempt-1", adjustmentId: "refund-1" }]);
  });
});

describe("F12: the unreachable journal entries", () => {
  test("a T+N batch statement posts the settlement sweep", async () => {
    resetJobDatabase();
    const client = createJobFake();
    const repositories = new PrismaRepositories(client as never);
    const ledgerPoster = new LedgerPoster(client as never);
    const statement = [
      "our_ref,amount,fee",
      "PA-BATCH-1,100.0000,0.8000",
    ].join("\n");

    client.glAccount.create({ data: { id: "acc-treasury", accountType: "TREASURY", currency: "LYD" } });
    client.glAccount.create({
      data: { id: "acc-clearing", accountType: "GATEWAY_CLEARING", gatewayId: "gateway-1", currency: "LYD" },
    });
    client.glAccount.create({
      data: { id: "acc-accrual", accountType: "GATEWAY_FEE_ACCRUAL", currency: "LYD" },
    });
    client.statementSource.create({
      data: {
        id: "source-1",
        gatewayId: "gateway-1",
        type: "UPLOAD",
        parserConfig: {
          format: "CSV",
          headerRow: true,
          supportsBatchNet: true,
          columnsMap: { ourReference: "our_ref", amount: "amount", fee: "fee" },
        },
        settlementLagDays: 2,
      },
    });
    client.reconciliationRun.create({
      data: {
        id: "run-1",
        statementSourceId: "source-1",
        windowStart: new Date("2026-10-01T00:00:00.000Z"),
        windowEnd: new Date("2026-10-31T00:00:00.000Z"),
        fileHash: "hash-1",
        fileName: "statement.csv",
        fileContent: Buffer.from(statement, "utf8"),
        ingestedAt: null,
      },
    });

    const handler = createReconciliationJobHandler({
      db: client as never,
      repositories,
      ledgerPoster,
      clock: () => new Date("2026-10-27T00:00:00.000Z"),
    });
    const job = {
      id: "job-1",
      jobType: "RECONCILIATION_RUN",
      referenceType: "RECONCILIATION_RUN",
      referenceId: "run-1",
      payloadJson: {},
      state: "QUEUED",
      attempts: 0,
      maxAttempts: 3,
      availableAt: new Date(),
      lockedAt: null,
      lastError: null,
      completedAt: null,
    };
    await handler.handle(job as never);

    const entries = jobTable("journalEntry").filter((row) => row.refType === "SETTLEMENT_SWEEP");
    expect(entries).toHaveLength(1);
    const lines = jobTable("journalLine").filter((row) => row.entryId === entries[0]?.id);
    const byAccount = new Map(lines.map((row) => [String(row.glAccountId), row]));
    expect(String(byAccount.get("acc-treasury")?.direction)).toBe("DEBIT");
    expect(new Decimal(String(byAccount.get("acc-treasury")?.amount)).toFixed(4)).toBe("99.2000");
    expect(String(byAccount.get("acc-accrual")?.direction)).toBe("DEBIT");
    expect(new Decimal(String(byAccount.get("acc-accrual")?.amount)).toFixed(4)).toBe("0.8000");
    expect(String(byAccount.get("acc-clearing")?.direction)).toBe("CREDIT");
    expect(new Decimal(String(byAccount.get("acc-clearing")?.amount)).toFixed(4)).toBe("100.0000");

    // A retried job never books the sweep twice.
    await handler.handle(job as never);
    expect(jobTable("journalEntry").filter((row) => row.refType === "SETTLEMENT_SWEEP")).toHaveLength(1);
  });

  test("a chargeback inside the negative balance ceiling posts CHARGEBACK_INSUFFICIENT", async () => {
    const fixture = buildFixture();
    await fixture.client.merchant.update({
      where: { id: "merchant-1" },
      data: { negativeBalanceCeiling: new Decimal(200) },
    });
    // The wallet is empty, so the chargeback drives it negative but stays
    // inside the 200 recovery ceiling.
    await fixture.client.journalLine.deleteMany({ where: { id: "settlement-line" } });

    const intake = await fixture.client.$transaction(async (tx) =>
      openDisputeWithDraftedAdjustment(fixture.context, tx as never, {
        attemptId: "attempt-1",
        gatewayId: "gateway-1",
        railId: "rail-1",
        externalDisputeRef: "DSP-INSUFFICIENT",
        source: "MANUAL",
        amount: new Decimal(100),
        currency: "LYD",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );

    const result = await runApproval(fixture, {
      subjectType: "ADJUSTMENT",
      subjectId: intake.adjustmentId!,
      payloadDiffJson: { type: "CHARGEBACK" },
      makerUserId: SYSTEM_AUTOMATION_USER_ID,
      checkerUserId: "user-finance",
      checkerRole: "FINANCE",
      outcome: "LOST",
      approvalId: intake.approvalRequestId!,
    });

    expect(result.status).toBe("EXECUTED");
    expect(result.template).toBe("CHARGEBACK_INSUFFICIENT");
    const adjustment = governanceTable("adjustment").find((row) => row.id === intake.adjustmentId!);
    expect(adjustment?.state).toBe("EXECUTED");
    expect(governanceTable("operatorCase")).toHaveLength(0);
  });
});

describe("money-integrity remediations (113, 126, 39, 48)", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  const seedRefund = async (id: string, amount: number, state: string): Promise<void> => {
    await fixture.client.adjustment.create({
      data: {
        id,
        type: "REFUND",
        targetGlAccountId: "acc-wallet",
        sourceAttemptId: "attempt-1",
        amount: new Decimal(amount),
        reverseCommission: true,
        reason: `Refund ${id}`,
        draftedBySystem: false,
        state,
      },
    });
  };

  test("defect 113: two 60 refunds on a 100 payment never refund 120", async () => {
    await seedRefund("refund-a", 60, "PENDING_REVIEW");
    await seedRefund("refund-b", 60, "PENDING_REVIEW");
    const calls: Array<{ adjustmentId: string; amount: string }> = [];
    fixture.context.engine = {
      refund: async (_attempt, amount, adjustmentId) => {
        calls.push({ adjustmentId, amount: amount.toFixed(4) });
        return { status: "REFUNDED", attempt: { ownershipMode: "PLATFORM_CLEARING" } };
      },
    };

    const first = await runApproval(fixture, {
      subjectType: "ADJUSTMENT",
      subjectId: "refund-a",
      payloadDiffJson: { type: "REFUND" },
      checkerUserId: "user-finance",
      checkerRole: "FINANCE",
      approvalId: "approval-refund-a",
    });
    expect(first.status).toBe("EXECUTED");
    expect(calls).toHaveLength(1);

    await expect(
      runApproval(fixture, {
        subjectType: "ADJUSTMENT",
        subjectId: "refund-b",
        payloadDiffJson: { type: "REFUND" },
        checkerUserId: "user-finance",
        checkerRole: "FINANCE",
        approvalId: "approval-refund-b",
      }),
    ).rejects.toThrow(/REFUND_EXCEEDS_SETTLED_AMOUNT|exceed/i);

    expect(calls).toHaveLength(1);
    expect(governanceTable("adjustment").find((row) => row.id === "refund-b")?.state).toBe("PENDING_REVIEW");
    expect(entryOf("ADJUSTMENT", "refund-b")).toBeUndefined();
  });

  test("defect 126: a chargeback is capped to the unrefunded amount", async () => {
    await seedRefund("refund-partial", 40, "EXECUTED");

    const intake = await fixture.client.$transaction(async (tx) =>
      openDisputeWithDraftedAdjustment(fixture.context, tx as never, {
        attemptId: "attempt-1",
        gatewayId: "gateway-1",
        railId: "rail-1",
        externalDisputeRef: "DSP-CAPPED",
        source: "MANUAL",
        amount: new Decimal(100),
        currency: "LYD",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );

    expect(intake.status).toBe("DRAFTED");
    expect(intake.adjustmentId).not.toBeNull();
    const adjustment = governanceTable("adjustment").find((row) => row.id === intake.adjustmentId);
    expect(new Decimal(String(adjustment?.amount)).toFixed(4)).toBe("60.0000");

    const reserve = entryOf("DISPUTE_OUTCOME", intake.disputeId);
    expect(reserve).toBeDefined();
    const byAccount = new Map(linesOf(String(reserve?.id)).map((row) => [String(row.glAccountId), row]));
    expect(amountOf(byAccount.get("acc-wallet")!)).toBe("57.0000");
    expect(amountOf(byAccount.get("acc-income")!)).toBe("3.0000");
    expect(amountOf(byAccount.get("acc-chargeback")!)).toBe("60.0000");
  });

  test("defect 126: a fully refunded attempt records the dispute without drafting a chargeback", async () => {
    await seedRefund("refund-full", 100, "EXECUTED");

    const intake = await fixture.client.$transaction(async (tx) =>
      openDisputeWithDraftedAdjustment(fixture.context, tx as never, {
        attemptId: "attempt-1",
        gatewayId: "gateway-1",
        railId: "rail-1",
        externalDisputeRef: "DSP-NO-CHARGEBACK",
        source: "MANUAL",
        amount: new Decimal(100),
        currency: "LYD",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );

    expect(intake.status).toBe("NO_CHARGEBACK_DRAFTED");
    expect(intake.reason).toBe("ATTEMPT_FULLY_REFUNDED");
    expect(intake.adjustmentId).toBeNull();
    expect(intake.approvalRequestId).toBeNull();
    expect(intake.escrowed).toBe(false);
    expect(governanceTable("dispute")).toHaveLength(1);
    expect(governanceTable("adjustment").filter((row) => row.type === "CHARGEBACK")).toHaveLength(0);
    expect(entryOf("DISPUTE_OUTCOME", intake.disputeId)).toBeUndefined();
  });

  test("defect 39: a refund is refused when the pinned rail does not support refunds", async () => {
    await fixture.client.paymentAttempt.update({
      where: { id: "attempt-1" },
      data: { railId: "rail-no-refund" },
    });
    await fixture.client.rail.create({
      data: {
        id: "rail-no-refund",
        code: "no-refund",
        capabilities: { refund: false, partial_refund: false },
      },
    });
    await seedRefund("refund-rail-blocked", 100, "PENDING_REVIEW");
    let calls = 0;
    fixture.context.engine = {
      refund: async () => {
        calls += 1;
        return { status: "REFUNDED" };
      },
    };

    await expect(
      runApproval(fixture, {
        subjectType: "ADJUSTMENT",
        subjectId: "refund-rail-blocked",
        payloadDiffJson: { type: "REFUND" },
        checkerUserId: "user-finance",
        checkerRole: "FINANCE",
      }),
    ).rejects.toThrow(/does not support refunds|REFUND_NOT_SUPPORTED/i);
    expect(calls).toBe(0);
  });

  test("defect 39: a partial refund is refused when the pinned rail only supports full refunds", async () => {
    await fixture.client.paymentAttempt.update({
      where: { id: "attempt-1" },
      data: { railId: "rail-full-only" },
    });
    await fixture.client.rail.create({
      data: {
        id: "rail-full-only",
        code: "full-only",
        capabilities: { refund: true, partial_refund: false },
      },
    });
    await seedRefund("refund-partial-blocked", 40, "PENDING_REVIEW");
    let calls = 0;
    fixture.context.engine = {
      refund: async () => {
        calls += 1;
        return { status: "REFUNDED" };
      },
    };

    await expect(
      runApproval(fixture, {
        subjectType: "ADJUSTMENT",
        subjectId: "refund-partial-blocked",
        payloadDiffJson: { type: "REFUND" },
        checkerUserId: "user-finance",
        checkerRole: "FINANCE",
      }),
    ).rejects.toThrow(/partial refunds|PARTIAL_REFUND_NOT_SUPPORTED/i);
    expect(calls).toBe(0);
  });

  test("defect 39: a refund outside the configured refund window is refused", async () => {
    await fixture.client.paymentAttempt.update({
      where: { id: "attempt-1" },
      data: {
        railId: "rail-windowed",
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      },
    });
    await fixture.client.rail.create({
      data: {
        id: "rail-windowed",
        code: "windowed",
        capabilities: { refund: true, partial_refund: true },
        refundWindowDays: 7,
      },
    });
    await seedRefund("refund-outside-window", 100, "PENDING_REVIEW");
    let calls = 0;
    fixture.context.engine = {
      refund: async () => {
        calls += 1;
        return { status: "REFUNDED" };
      },
    };

    await expect(
      runApproval(fixture, {
        subjectType: "ADJUSTMENT",
        subjectId: "refund-outside-window",
        payloadDiffJson: { type: "REFUND" },
        checkerUserId: "user-finance",
        checkerRole: "FINANCE",
      }),
    ).rejects.toThrow(/refund window|REFUND_WINDOW_EXPIRED/i);
    expect(calls).toBe(0);
  });

  test("defect 48: the commission receivable ceiling comparison pauses or nets traffic", async () => {
    await fixture.client.glAccount.create({
      data: { id: "acc-receivable", accountType: "COMMISSION_RECEIVABLE", currency: "LYD" },
    });
    await fixture.client.journalEntry.create({
      data: { id: "receivable-entry", refType: "PAYMENT_ATTEMPT", refId: "attempt-1" },
    });
    await fixture.client.journalLine.create({
      data: {
        id: "receivable-line",
        entryId: "receivable-entry",
        glAccountId: "acc-receivable",
        direction: "DEBIT",
        amount: new Decimal(120),
      },
    });
    await fixture.client.merchant.update({
      where: { id: "merchant-1" },
      data: { commissionReceivableCeiling: new Decimal(100) },
    });

    const evaluation = await fixture.client.$transaction(async (tx) =>
      evaluateCommissionReceivableCeiling(fixture.context, tx as never, "merchant-1"),
    );
    expect(evaluation.receivable.toFixed(4)).toBe("120.0000");
    expect(evaluation.ceiling?.toFixed(4)).toBe("100.0000");
    expect(evaluation.exceeded).toBe(true);
    expect(evaluation.decision).toBe("PAUSE");
    expect(evaluation.reason).toBe("CEILING_EXCEEDED_PAUSE");

    const netting = decideCommissionReceivableCeiling({
      merchantId: "merchant-1",
      receivable: new Decimal(120),
      ceiling: new Decimal(100),
      settlementTarget: "MERCHANT_DIRECT",
    });
    expect(netting.decision).toBe("NETTING");
    expect(netting.reason).toBe("CEILING_EXCEEDED_NETTING");

    const within = decideCommissionReceivableCeiling({
      merchantId: "merchant-1",
      receivable: new Decimal(50),
      ceiling: new Decimal(100),
    });
    expect(within.decision).toBe("ALLOW");
    expect(within.reason).toBe("WITHIN_CEILING");

    const noCeiling = decideCommissionReceivableCeiling({
      merchantId: "merchant-1",
      receivable: new Decimal(50),
      ceiling: null,
    });
    expect(noCeiling.decision).toBe("ALLOW");
    expect(noCeiling.reason).toBe("NO_CEILING");
  });
});
