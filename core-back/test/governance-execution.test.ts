import { beforeEach, describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import { PrismaRepositories } from "../engine/db/repositories";
import { LedgerPoster, decimal } from "../engine/ledger/LedgerPoster";
import {
  SYSTEM_AUTOMATION_USER_ID,
  executeApprovalSubject,
  executeCashout,
  openDisputeWithDraftedAdjustment,
  type GovernanceExecutionContext,
} from "../engine/governance/GovernanceExecution";
import {
  createFakePrisma,
  fakeTable,
  resetFakeDatabase,
  type FakePrisma,
  type FakeRow,
} from "./helpers/governanceFake";

interface Fixture {
  client: FakePrisma;
  context: GovernanceExecutionContext;
}

const line = (entryId: string): FakeRow[] =>
  fakeTable("journalLine").filter((row) => row.entryId === entryId);

const amountOf = (row: FakeRow): string => decimal(row.amount as never).toFixed(4);

const entryOf = (refType: string, refId: string): FakeRow | undefined =>
  fakeTable("journalEntry").find((row) => row.refType === refType && row.refId === refId);

const rowsOf = (table: string): FakeRow[] => fakeTable(table);

const buildFixture = (): Fixture => {
  resetFakeDatabase();
  const client = createFakePrisma();
  const repositories = new PrismaRepositories(client as never);
  const ledgerPoster = new LedgerPoster(client as never);

  client.glAccount.create({
    data: { id: "acc-treasury", accountType: "TREASURY", currency: "LYD" },
  });
  client.glAccount.create({
    data: { id: "acc-clearing", accountType: "GATEWAY_CLEARING", currency: "LYD" },
  });
  client.glAccount.create({
    data: { id: "acc-wallet", accountType: "MERCHANT_WALLET", ownerId: "merchant-1", currency: "LYD" },
  });
  client.glAccount.create({
    data: { id: "acc-income", accountType: "PLATFORM_INCOME", currency: "LYD" },
  });
  client.glAccount.create({
    data: { id: "acc-aml-hold", accountType: "AML_HOLD", currency: "LYD" },
  });
  client.glAccount.create({
    data: { id: "acc-chargeback", accountType: "CHARGEBACK_RESERVE", currency: "LYD" },
  });
  client.glAccount.create({
    data: { id: "acc-gateway-fee", accountType: "GATEWAY_FEE_EXPENSE", currency: "LYD" },
  });
  client.glAccount.create({
    data: { id: "acc-gateway-accrual", accountType: "GATEWAY_FEE_ACCRUAL", currency: "LYD" },
  });

  client.user.create({
    data: {
      id: "user-maker",
      email: "maker@payment-gateway.internal",
      role: "COMPLIANCE",
      authoritiesMap: {},
      appScopeIds: [],
      isMaker: true,
      isChecker: false,
      mfaRequired: false,
      status: "ACTIVE",
    },
  });
  client.user.create({
    data: {
      id: "user-checker",
      email: "checker@payment-gateway.internal",
      role: "MLRO",
      authoritiesMap: {},
      appScopeIds: [],
      isMaker: false,
      isChecker: true,
      mfaRequired: false,
      status: "ACTIVE",
    },
  });
  client.user.create({
    data: {
      id: "user-finance",
      email: "finance@payment-gateway.internal",
      role: "FINANCE",
      authoritiesMap: {},
      appScopeIds: [],
      isMaker: false,
      isChecker: true,
      mfaRequired: false,
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
      currency: "LYD",
      env: "LIVE",
      status: "SUCCEEDED",
      totalChargedAmount: new Decimal(100),
      platformCommissionAmount: new Decimal(3),
      netMerchantAmount: new Decimal(97),
      settlementTarget: "PLATFORM_CLEARING",
    },
  });

  // The AML hold that the case points at.
  client.journalEntry.create({
    data: { id: "hold-entry", refType: "PAYMENT_ATTEMPT", refId: "attempt-1", description: "AML threshold hold" },
  });
  client.journalLine.create({
    data: {
      id: "hold-line",
      entryId: "hold-entry",
      glAccountId: "acc-aml-hold",
      direction: "CREDIT",
      amount: new Decimal(100),
    },
  });

  // The balance the merchant wallet holds after a settled payment.
  client.journalEntry.create({
    data: {
      id: "settlement-entry",
      refType: "PAYMENT_ATTEMPT",
      refId: "attempt-0",
      description: "Settled payment",
    },
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

  client.amlCase.create({
    data: {
      id: "aml-case-1",
      subjectType: "PAYMENT_ATTEMPT",
      subjectId: "attempt-1",
      triggerReason: "AML_RULE:AML-SINGLE-AMOUNT",
      severity: "HIGH",
      severityInputsJson: {},
      status: "OPEN",
      holdJournalEntryId: "hold-entry",
      confidential: true,
    },
  });

  return { client, context: { ledgerPoster, repositories } };
};

const approve = async (
  fixture: Fixture,
  input: {
    approvalId?: string;
    subjectType: string;
    subjectId: string;
    payloadDiffJson?: unknown;
    makerUserId: string;
    checkerUserId: string;
    checkerRole: string;
    outcome?: "WON" | "LOST";
  },
): Promise<{ status: string; journalEntryId: string | null; reason?: string }> => {
  const approval = await fixture.client.approvalRequest.create({
    data: {
      id: input.approvalId ?? "approval-1",
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payloadDiffJson: input.payloadDiffJson ?? {},
      mode: "STANDARD",
      makerUserId: input.makerUserId,
      state: "PENDING_REVIEW",
    },
  });
  const result = await fixture.client.$transaction(async (tx) =>
    executeApprovalSubject(fixture.context, tx as never, {
      approval: {
        id: String(approval.id),
        subjectType: approval.subjectType,
        subjectId: approval.subjectId,
        payloadDiffJson: approval.payloadDiffJson,
        makerUserId: approval.makerUserId,
      },
      checkerUserId: input.checkerUserId,
      checkerRole: input.checkerRole,
      outcome: input.outcome ?? null,
    }),
  );
  return {
    status: result.status,
    journalEntryId: result.journalEntryId ?? null,
    reason: result.reason,
  };
};

describe("governance execution", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  test("approving an AML hold posts the release entry and closes the case", async () => {
    const result = await approve(fixture, {
      subjectType: "AML_CASE",
      subjectId: "aml-case-1",
      payloadDiffJson: { action: "RELEASE" },
      makerUserId: "user-maker",
      checkerUserId: "user-checker",
      checkerRole: "MLRO",
    });

    expect(result.status).toBe("EXECUTED");
    const entry = entryOf("AML_RELEASE", "attempt-1");
    expect(entry).toBeDefined();
    const lines = line(String(entry?.id));
    expect(lines).toHaveLength(3);
    const byAccount = new Map(lines.map((row) => [String(row.glAccountId), row]));
    expect(String(byAccount.get("acc-aml-hold")?.direction)).toBe("DEBIT");
    expect(amountOf(byAccount.get("acc-aml-hold")!)).toBe("100.0000");
    expect(String(byAccount.get("acc-wallet")?.direction)).toBe("CREDIT");
    expect(amountOf(byAccount.get("acc-wallet")!)).toBe("97.0000");
    expect(String(byAccount.get("acc-income")?.direction)).toBe("CREDIT");
    expect(amountOf(byAccount.get("acc-income")!)).toBe("3.0000");

    const amlCase = rowsOf("amlCase").find((row) => row.id === "aml-case-1");
    expect(amlCase?.status).toBe("RELEASED");
    expect(amlCase?.assignedReviewerId).toBe("user-checker");

    const audit = rowsOf("auditLog").find((row) => row.action === "AML_CASE_RESOLVED");
    expect(audit).toBeDefined();
    expect(audit?.entityId).toBe("aml-case-1");
  });

  test("approving an AML rejection posts the void entry and returns the funds", async () => {
    const result = await approve(fixture, {
      subjectType: "AML_CASE",
      subjectId: "aml-case-1",
      payloadDiffJson: { action: "REJECT" },
      makerUserId: "user-maker",
      checkerUserId: "user-checker",
      checkerRole: "MLRO",
    });

    expect(result.status).toBe("EXECUTED");
    const entry = entryOf("AML_VOID", "attempt-1");
    expect(entry).toBeDefined();
    const lines = line(String(entry?.id));
    const byAccount = new Map(lines.map((row) => [String(row.glAccountId), row]));
    expect(String(byAccount.get("acc-aml-hold")?.direction)).toBe("DEBIT");
    expect(amountOf(byAccount.get("acc-aml-hold")!)).toBe("100.0000");
    expect(String(byAccount.get("acc-treasury")?.direction)).toBe("CREDIT");
    expect(amountOf(byAccount.get("acc-treasury")!)).toBe("100.0000");

    const amlCase = rowsOf("amlCase").find((row) => row.id === "aml-case-1");
    expect(amlCase?.status).toBe("REJECTED_VOID");
  });

  test("a merchant direct case closes without any posting", async () => {
    await fixture.client.paymentAttempt.update({
      where: { id: "attempt-1" },
      data: { settlementTarget: "MERCHANT_DIRECT" },
    });

    const result = await approve(fixture, {
      subjectType: "AML_CASE",
      subjectId: "aml-case-1",
      payloadDiffJson: { action: "RELEASE" },
      makerUserId: "user-maker",
      checkerUserId: "user-checker",
      checkerRole: "MLRO",
    });

    expect(result.status).toBe("EXECUTED");
    expect(result.journalEntryId).toBeNull();
    expect(rowsOf("journalEntry")).toHaveLength(2);
    expect(entryOf("AML_RELEASE", "attempt-1")).toBeUndefined();
    const amlCase = rowsOf("amlCase").find((row) => row.id === "aml-case-1");
    expect(amlCase?.status).toBe("RELEASED");
  });

  test("an escalated AML case raises an operator case", async () => {
    const result = await approve(fixture, {
      subjectType: "AML_CASE",
      subjectId: "aml-case-1",
      payloadDiffJson: { action: "ESCALATE" },
      makerUserId: "user-maker",
      checkerUserId: "user-checker",
      checkerRole: "MLRO",
    });

    expect(result.status).toBe("EXECUTED");
    expect(rowsOf("journalEntry")).toHaveLength(2);
    const amlCase = rowsOf("amlCase").find((row) => row.id === "aml-case-1");
    expect(amlCase?.status).toBe("ESCALATED_STR");
    const operatorCase = rowsOf("operatorCase")[0];
    expect(operatorCase?.kind).toBe("MANUAL_REVIEW");
    expect(operatorCase?.priority).toBe("P1");
  });

  test("opening a dispute drafts a system adjustment and escrows the money", async () => {
    const result = await fixture.client.$transaction(async (tx) =>
      openDisputeWithDraftedAdjustment(fixture.context, tx as never, {
        attemptId: "attempt-1",
        gatewayId: "gateway-1",
        railId: "rail-1",
        externalDisputeRef: "DSP-0001",
        source: "MANUAL",
        amount: new Decimal(100),
        currency: "LYD",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );

    const adjustment = rowsOf("adjustment").find((row) => row.id === result.adjustmentId);
    expect(adjustment?.type).toBe("CHARGEBACK");
    expect(adjustment?.state).toBe("PENDING_REVIEW");
    expect(adjustment?.draftedBySystem).toBe(true);
    expect(adjustment?.disputeId).toBe(result.disputeId);
    expect(adjustment?.externalDisputeRef).toBe("DSP-0001");

    const approval = rowsOf("approvalRequest").find((row) => row.id === result.approvalRequestId);
    expect(approval?.subjectType).toBe("ADJUSTMENT");
    expect(approval?.makerUserId).toBe(SYSTEM_AUTOMATION_USER_ID);
    expect(approval?.state).toBe("PENDING_REVIEW");

    const reserve = entryOf("DISPUTE_OUTCOME", result.disputeId);
    expect(reserve).toBeDefined();
    const lines = line(String(reserve?.id));
    const byAccount = new Map(lines.map((row) => [String(row.glAccountId), row]));
    expect(String(byAccount.get("acc-wallet")?.direction)).toBe("DEBIT");
    expect(amountOf(byAccount.get("acc-wallet")!)).toBe("97.0000");
    expect(String(byAccount.get("acc-income")?.direction)).toBe("DEBIT");
    expect(amountOf(byAccount.get("acc-income")!)).toBe("3.0000");
    expect(String(byAccount.get("acc-chargeback")?.direction)).toBe("CREDIT");
    expect(amountOf(byAccount.get("acc-chargeback")!)).toBe("100.0000");
  });

  test("the same dispute reference is never drafted twice", async () => {
    const input = {
      attemptId: "attempt-1",
      gatewayId: "gateway-1",
      railId: "rail-1",
      externalDisputeRef: "DSP-0001",
      source: "MANUAL" as const,
      amount: new Decimal(100),
      currency: "LYD",
      actorUserId: "user-finance",
      actorRole: "FINANCE",
    };
    await fixture.client.$transaction(async (tx) =>
      openDisputeWithDraftedAdjustment(fixture.context, tx as never, input),
    );
    expect(
      fixture.client.$transaction(async (tx) =>
        openDisputeWithDraftedAdjustment(fixture.context, tx as never, input),
      ),
    ).rejects.toThrow();
    expect(rowsOf("dispute")).toHaveLength(1);
    expect(rowsOf("adjustment")).toHaveLength(1);
  });

  test("a finance checker executes the drafted chargeback and posts the outcome", async () => {
    const intake = await fixture.client.$transaction(async (tx) =>
      openDisputeWithDraftedAdjustment(fixture.context, tx as never, {
        attemptId: "attempt-1",
        gatewayId: "gateway-1",
        railId: "rail-1",
        externalDisputeRef: "DSP-0001",
        source: "MANUAL",
        amount: new Decimal(100),
        currency: "LYD",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );

    const result = await approve(fixture, {
      approvalId: intake.approvalRequestId!,
      subjectType: "ADJUSTMENT",
      subjectId: intake.adjustmentId!,
      payloadDiffJson: { type: "CHARGEBACK" },
      makerUserId: SYSTEM_AUTOMATION_USER_ID,
      checkerUserId: "user-finance",
      checkerRole: "FINANCE",
      outcome: "LOST",
    });

    expect(result.status).toBe("EXECUTED");
    const outcome = entryOf("DISPUTE_OUTCOME", intake.adjustmentId!);
    expect(outcome).toBeDefined();
    const byAccount = new Map(
      line(String(outcome?.id)).map((row) => [String(row.glAccountId), row]),
    );
    expect(String(byAccount.get("acc-chargeback")?.direction)).toBe("DEBIT");
    expect(amountOf(byAccount.get("acc-chargeback")!)).toBe("100.0000");
    expect(String(byAccount.get("acc-treasury")?.direction)).toBe("CREDIT");

    const adjustment = rowsOf("adjustment").find((row) => row.id === intake.adjustmentId!);
    expect(adjustment?.state).toBe("EXECUTED");
    expect(adjustment?.journalEntryId).toBe(String(outcome?.id));
    const dispute = rowsOf("dispute").find((row) => row.id === intake.disputeId);
    expect(dispute?.status).toBe("LOST");
  });

  test("a chargeback below the negative balance ceiling is held for review", async () => {
    // The merchant wallet is emptied, so the chargeback pushes it below the
    // ceiling of zero.
    await fixture.client.journalLine.deleteMany({ where: { id: "settlement-line" } });

    const intake = await fixture.client.$transaction(async (tx) =>
      openDisputeWithDraftedAdjustment(fixture.context, tx as never, {
        attemptId: "attempt-1",
        gatewayId: "gateway-1",
        railId: "rail-1",
        externalDisputeRef: "DSP-0002",
        source: "MANUAL",
        amount: new Decimal(100),
        currency: "LYD",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );

    // The merchant wallet is empty, so the chargeback pushes it below the
    // ceiling of zero.
    const result = await approve(fixture, {
      approvalId: intake.approvalRequestId!,
      subjectType: "ADJUSTMENT",
      subjectId: intake.adjustmentId!,
      payloadDiffJson: { type: "CHARGEBACK" },
      makerUserId: SYSTEM_AUTOMATION_USER_ID,
      checkerUserId: "user-finance",
      checkerRole: "FINANCE",
      outcome: "LOST",
    });

    expect(result.status).toBe("HELD");
    expect(result.reason).toBe("NEGATIVE_BALANCE_CEILING_EXCEEDED");
    const adjustment = rowsOf("adjustment").find((row) => row.id === intake.adjustmentId!);
    expect(adjustment?.state).toBe("PENDING_REVIEW");
    expect(entryOf("DISPUTE_OUTCOME", intake.adjustmentId!)).toBeUndefined();
    const operatorCase = rowsOf("operatorCase")[0];
    expect(operatorCase?.priority).toBe("P1");
  });

  test("a draft adjustment is executed by a human checker", async () => {
    await fixture.client.adjustment.create({
      data: {
        id: "adjustment-1",
        type: "CORRECTION",
        targetGlAccountId: "acc-gateway-accrual",
        amount: new Decimal("0.1"),
        reason: "Settlement fee variance",
        draftedBySystem: false,
        state: "PENDING_REVIEW",
        reverseCommission: false,
      },
    });

    const result = await approve(fixture, {
      subjectType: "ADJUSTMENT",
      subjectId: "adjustment-1",
      payloadDiffJson: { type: "CORRECTION" },
      makerUserId: "user-maker",
      checkerUserId: "user-finance",
      checkerRole: "FINANCE",
    });

    expect(result.status).toBe("EXECUTED");
    const entry = entryOf("FEE_VARIANCE", "adjustment-1");
    expect(entry).toBeDefined();
    const byAccount = new Map(line(String(entry?.id)).map((row) => [String(row.glAccountId), row]));
    expect(String(byAccount.get("acc-gateway-fee")?.direction)).toBe("DEBIT");
    expect(amountOf(byAccount.get("acc-gateway-fee")!)).toBe("0.1000");
    expect(String(byAccount.get("acc-gateway-accrual")?.direction)).toBe("CREDIT");
    const adjustment = rowsOf("adjustment").find((row) => row.id === "adjustment-1");
    expect(adjustment?.state).toBe("EXECUTED");

    // The same approval never posts a second journal entry.
    const entries = rowsOf("journalEntry").length;
    const again = await approve(fixture, {
      approvalId: "approval-correction-again",
      subjectType: "ADJUSTMENT",
      subjectId: "adjustment-1",
      payloadDiffJson: { type: "CORRECTION" },
      makerUserId: "user-maker",
      checkerUserId: "user-finance",
      checkerRole: "FINANCE",
    });
    expect(again.status).toBe("SKIPPED");
    expect(rowsOf("journalEntry")).toHaveLength(entries);
  });

  test("executing a cash-out posts the cash-out entry and marks the request executed", async () => {
    await fixture.client.cashoutRequest.create({
      data: {
        id: "cashout-1",
        merchantId: "merchant-1",
        walletId: "wallet-1",
        amount: new Decimal(100),
        destinationBankJson: { iban: "LIB0000000000000000000000" },
        state: "PENDING",
      },
    });

    const result = await fixture.client.$transaction(async (tx) =>
      executeCashout(fixture.context, tx as never, {
        cashoutId: "cashout-1",
        decision: "APPROVE",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );

    expect(result.status).toBe("EXECUTED");
    const adjustment = rowsOf("adjustment")[0];
    const entry = entryOf("ADJUSTMENT", String(adjustment?.id));
    expect(entry).toBeDefined();
    const byAccount = new Map(line(String(entry?.id)).map((row) => [String(row.glAccountId), row]));
    expect(String(byAccount.get("acc-wallet")?.direction)).toBe("DEBIT");
    expect(amountOf(byAccount.get("acc-wallet")!)).toBe("100.0000");
    expect(String(byAccount.get("acc-treasury")?.direction)).toBe("CREDIT");
    expect(amountOf(byAccount.get("acc-treasury")!)).toBe("100.0000");

    const cashout = rowsOf("cashoutRequest").find((row) => row.id === "cashout-1");
    expect(cashout?.state).toBe("COMPLETE");
    expect(cashout?.adjustmentId).toBe(String(adjustment?.id));
  });

  test("a rejected cash-out releases the money and records the reason", async () => {
    await fixture.client.cashoutRequest.create({
      data: {
        id: "cashout-2",
        merchantId: "merchant-1",
        walletId: "wallet-1",
        amount: new Decimal(100),
        destinationBankJson: {},
        state: "PENDING",
      },
    });

    const result = await fixture.client.$transaction(async (tx) =>
      executeCashout(fixture.context, tx as never, {
        cashoutId: "cashout-2",
        decision: "REJECT",
        reason: "The destination account is wrong",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );

    expect(result.status).toBe("EXECUTED");
    const cashout = rowsOf("cashoutRequest").find((row) => row.id === "cashout-2");
    expect(cashout?.state).toBe("REJECTED");
    expect(rowsOf("journalEntry")).toHaveLength(2);
    const adjustment = rowsOf("adjustment")[0];
    expect(String(adjustment?.reason)).toContain("The destination account is wrong");
    expect(adjustment?.state).toBe("REJECTED");
    const audit = rowsOf("auditLog").find((row) => row.action === "CASHOUT_REJECTED");
    expect(audit).toBeDefined();
  });

  test("every execution is idempotent", async () => {
    const first = await approve(fixture, {
      subjectType: "AML_CASE",
      subjectId: "aml-case-1",
      payloadDiffJson: { action: "RELEASE" },
      makerUserId: "user-maker",
      checkerUserId: "user-checker",
      checkerRole: "MLRO",
    });
    expect(first.status).toBe("EXECUTED");
    expect(rowsOf("journalEntry")).toHaveLength(3);

    const second = await approve(fixture, {
      approvalId: "approval-2",
      subjectType: "AML_CASE",
      subjectId: "aml-case-1",
      payloadDiffJson: { action: "RELEASE" },
      makerUserId: "user-maker",
      checkerUserId: "user-checker",
      checkerRole: "MLRO",
    });
    expect(second.status).toBe("SKIPPED");
    expect(rowsOf("journalEntry")).toHaveLength(3);
    expect(line(String(entryOf("AML_RELEASE", "attempt-1")?.id))).toHaveLength(3);
  });

  test("a repeated cash-out never creates a second journal entry", async () => {
    await fixture.client.cashoutRequest.create({
      data: {
        id: "cashout-3",
        merchantId: "merchant-1",
        walletId: "wallet-1",
        amount: new Decimal(100),
        destinationBankJson: {},
        state: "PENDING",
      },
    });
    await fixture.client.$transaction(async (tx) =>
      executeCashout(fixture.context, tx as never, {
        cashoutId: "cashout-3",
        decision: "APPROVE",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );
    const entries = rowsOf("journalEntry").length;
    const adjustments = rowsOf("adjustment").length;

    const second = await fixture.client.$transaction(async (tx) =>
      executeCashout(fixture.context, tx as never, {
        cashoutId: "cashout-3",
        decision: "APPROVE",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );
    expect(second.status).toBe("SKIPPED");
    expect(rowsOf("journalEntry")).toHaveLength(entries);
    expect(rowsOf("adjustment")).toHaveLength(adjustments);
  });

  test("the maker and the checker are never the same user", async () => {
    expect(
      approve(fixture, {
        subjectType: "AML_CASE",
        subjectId: "aml-case-1",
        payloadDiffJson: { action: "RELEASE" },
        makerUserId: "user-maker",
        checkerUserId: "user-maker",
        checkerRole: "COMPLIANCE",
      }),
    ).rejects.toThrow(/maker and the checker/i);
    expect(rowsOf("journalEntry")).toHaveLength(2);
  });

  test("the system automation principal can never be the checker", async () => {
    expect(
      approve(fixture, {
        subjectType: "AML_CASE",
        subjectId: "aml-case-1",
        payloadDiffJson: { action: "RELEASE" },
        makerUserId: "user-maker",
        checkerUserId: SYSTEM_AUTOMATION_USER_ID,
        checkerRole: "OPERATOR",
      }),
    ).rejects.toThrow(/automation/i);
    expect(rowsOf("journalEntry")).toHaveLength(2);
  });

  test("the system automation principal is a disabled service identity", async () => {
    await fixture.client.$transaction(async (tx) =>
      openDisputeWithDraftedAdjustment(fixture.context, tx as never, {
        attemptId: "attempt-1",
        gatewayId: "gateway-1",
        railId: "rail-1",
        externalDisputeRef: "DSP-0003",
        source: "MANUAL",
        amount: new Decimal(100),
        currency: "LYD",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );
    const system = rowsOf("user").find((row) => row.id === SYSTEM_AUTOMATION_USER_ID);
    expect(system).toBeDefined();
    expect(system?.status).toBe("DISABLED");
    expect(system?.isChecker).toBe(false);
  });

  test("a failed posting leaves no state change behind", async () => {
    // The treasury account is missing, so the ledger posting fails.
    await fixture.client.glAccount.deleteMany({ where: { id: "acc-treasury" } });

    expect(
      approve(fixture, {
        subjectType: "AML_CASE",
        subjectId: "aml-case-1",
        payloadDiffJson: { action: "REJECT" },
        makerUserId: "user-maker",
        checkerUserId: "user-checker",
        checkerRole: "MLRO",
      }),
    ).rejects.toThrow();

    const amlCase = rowsOf("amlCase").find((row) => row.id === "aml-case-1");
    expect(amlCase?.status).toBe("OPEN");
    expect(rowsOf("journalEntry")).toHaveLength(2);
    expect(rowsOf("journalLine")).toHaveLength(2);
    expect(rowsOf("auditLog")).toHaveLength(0);
  });

  test("a chargeback is never authorised by a non finance checker", async () => {
    const intake = await fixture.client.$transaction(async (tx) =>
      openDisputeWithDraftedAdjustment(fixture.context, tx as never, {
        attemptId: "attempt-1",
        gatewayId: "gateway-1",
        railId: "rail-1",
        externalDisputeRef: "DSP-0004",
        source: "MANUAL",
        amount: new Decimal(100),
        currency: "LYD",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );

    expect(
      approve(fixture, {
        approvalId: intake.approvalRequestId!,
        subjectType: "ADJUSTMENT",
        subjectId: intake.adjustmentId!,
        payloadDiffJson: { type: "CHARGEBACK" },
        makerUserId: SYSTEM_AUTOMATION_USER_ID,
        checkerUserId: "user-checker",
        checkerRole: "MLRO",
        outcome: "LOST",
      }),
    ).rejects.toThrow(/finance/i);

    const adjustment = rowsOf("adjustment").find((row) => row.id === intake.adjustmentId!);
    expect(adjustment?.state).toBe("PENDING_REVIEW");
    expect(entryOf("DISPUTE_OUTCOME", intake.adjustmentId!)).toBeUndefined();
  });

  test("a merchant direct dispute is never escrowed", async () => {
    await fixture.client.paymentAttempt.update({
      where: { id: "attempt-1" },
      data: { settlementTarget: "MERCHANT_DIRECT" },
    });

    const intake = await fixture.client.$transaction(async (tx) =>
      openDisputeWithDraftedAdjustment(fixture.context, tx as never, {
        attemptId: "attempt-1",
        gatewayId: "gateway-1",
        railId: "rail-1",
        externalDisputeRef: "DSP-0005",
        source: "MANUAL",
        amount: new Decimal(100),
        currency: "LYD",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );

    expect(intake.escrowed).toBe(false);
    expect(intake.journalEntryId).toBeNull();
    expect(entryOf("DISPUTE_OUTCOME", intake.disputeId)).toBeUndefined();
    const adjustment = rowsOf("adjustment").find((row) => row.id === intake.adjustmentId!);
    expect(adjustment?.state).toBe("PENDING_REVIEW");
  });

  test("a manual debit and a manual credit post the matching wallet movements", async () => {
    await fixture.client.adjustment.create({
      data: {
        id: "adjustment-debit",
        type: "MANUAL_DEBIT",
        targetGlAccountId: "acc-wallet",
        amount: new Decimal(25),
        reason: "Write off of an uncollectable balance",
        draftedBySystem: false,
        state: "PENDING_REVIEW",
        reverseCommission: false,
      },
    });
    await fixture.client.adjustment.create({
      data: {
        id: "adjustment-credit",
        type: "MANUAL_CREDIT",
        targetGlAccountId: "acc-wallet",
        amount: new Decimal(15),
        reason: "Goodwill credit",
        draftedBySystem: false,
        state: "PENDING_REVIEW",
        reverseCommission: false,
      },
    });

    await approve(fixture, {
      approvalId: "approval-debit",
      subjectType: "ADJUSTMENT",
      subjectId: "adjustment-debit",
      payloadDiffJson: { type: "MANUAL_DEBIT" },
      makerUserId: "user-maker",
      checkerUserId: "user-finance",
      checkerRole: "FINANCE",
    });
    await approve(fixture, {
      approvalId: "approval-credit",
      subjectType: "ADJUSTMENT",
      subjectId: "adjustment-credit",
      payloadDiffJson: { type: "MANUAL_CREDIT" },
      makerUserId: "user-maker",
      checkerUserId: "user-finance",
      checkerRole: "FINANCE",
    });

    const debit = entryOf("ADJUSTMENT", "adjustment-debit");
    expect(debit).toBeDefined();
    const debitLines = new Map(line(String(debit?.id)).map((row) => [String(row.glAccountId), row]));
    expect(String(debitLines.get("acc-wallet")?.direction)).toBe("DEBIT");
    expect(amountOf(debitLines.get("acc-wallet")!)).toBe("25.0000");
    expect(String(debitLines.get("acc-treasury")?.direction)).toBe("CREDIT");

    const credit = entryOf("ADJUSTMENT", "adjustment-credit");
    expect(credit).toBeDefined();
    const creditLines = new Map(line(String(credit?.id)).map((row) => [String(row.glAccountId), row]));
    expect(String(creditLines.get("acc-treasury")?.direction)).toBe("DEBIT");
    expect(amountOf(creditLines.get("acc-treasury")!)).toBe("15.0000");
    expect(String(creditLines.get("acc-wallet")?.direction)).toBe("CREDIT");
    expect(amountOf(creditLines.get("acc-wallet")!)).toBe("15.0000");
  });
  test("a second partial refund cannot exceed the charged amount", async () => {
    const calls: string[] = [];
    fixture.context.engine = {
      refund: async (_attempt, amount, adjustmentId) => {
        calls.push(`${adjustmentId}:${amount.toFixed(4)}`);
        return { status: "REFUNDED", attempt: { ownershipMode: "PLATFORM_CLEARING" } };
      },
    };
    await fixture.client.adjustment.create({
      data: {
        id: "refund-a",
        type: "REFUND",
        targetGlAccountId: "acc-wallet",
        sourceAttemptId: "attempt-1",
        amount: new Decimal(60),
        reverseCommission: true,
        reason: "First partial refund",
        draftedBySystem: false,
        state: "PENDING_REVIEW",
      },
    });
    await fixture.client.adjustment.create({
      data: {
        id: "refund-b",
        type: "REFUND",
        targetGlAccountId: "acc-wallet",
        sourceAttemptId: "attempt-1",
        amount: new Decimal(60),
        reverseCommission: true,
        reason: "Second partial refund",
        draftedBySystem: false,
        state: "PENDING_REVIEW",
      },
    });

    const first = await approve(fixture, {
      approvalId: "approval-refund-a",
      subjectType: "ADJUSTMENT",
      subjectId: "refund-a",
      payloadDiffJson: { type: "REFUND" },
      makerUserId: "user-maker",
      checkerUserId: "user-finance",
      checkerRole: "FINANCE",
    });
    expect(first.status).toBe("EXECUTED");
    expect(calls).toEqual(["refund-a:60.0000"]);

    await expect(
      approve(fixture, {
        approvalId: "approval-refund-b",
        subjectType: "ADJUSTMENT",
        subjectId: "refund-b",
        payloadDiffJson: { type: "REFUND" },
        makerUserId: "user-maker",
        checkerUserId: "user-finance",
        checkerRole: "FINANCE",
      }),
    ).rejects.toThrow(/REFUND_EXCEEDS_SETTLED_AMOUNT|exceed/i);
    expect(calls).toEqual(["refund-a:60.0000"]);
    expect(rowsOf("adjustment").find((row) => row.id === "refund-b")?.state).toBe("PENDING_REVIEW");
    expect(entryOf("ADJUSTMENT", "refund-b")).toBeUndefined();
  });

  test("a chargeback is capped to the unrefunded amount after a partial refund", async () => {
    await fixture.client.adjustment.create({
      data: {
        id: "refund-partial",
        type: "REFUND",
        targetGlAccountId: "acc-wallet",
        sourceAttemptId: "attempt-1",
        amount: new Decimal(40),
        reverseCommission: true,
        reason: "Partial refund before the chargeback",
        draftedBySystem: false,
        state: "EXECUTED",
      },
    });

    const intake = await fixture.client.$transaction(async (tx) =>
      openDisputeWithDraftedAdjustment(fixture.context, tx as never, {
        attemptId: "attempt-1",
        gatewayId: "gateway-1",
        railId: "rail-1",
        externalDisputeRef: "DSP-PARTIAL",
        source: "MANUAL",
        amount: new Decimal(100),
        currency: "LYD",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );
    expect(intake.status).toBe("DRAFTED");
    expect(intake.adjustmentId).not.toBeNull();
    const adjustment = rowsOf("adjustment").find((row) => row.id === intake.adjustmentId);
    expect(new Decimal(String(adjustment?.amount)).toFixed(4)).toBe("60.0000");

    const reserve = entryOf("DISPUTE_OUTCOME", intake.disputeId);
    expect(reserve).toBeDefined();
    const byAccount = new Map(line(String(reserve?.id)).map((row) => [String(row.glAccountId), row]));
    expect(amountOf(byAccount.get("acc-wallet")!)).toBe("57.0000");
    expect(amountOf(byAccount.get("acc-income")!)).toBe("3.0000");
    expect(amountOf(byAccount.get("acc-chargeback")!)).toBe("60.0000");
  });

});
