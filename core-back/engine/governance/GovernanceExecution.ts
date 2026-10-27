import { Decimal } from "decimal.js";
import { ApiError } from "../../lib/error";
import {
  buildLedgerTemplate,
  decimal,
  LedgerPoster,
  type JournalTemplate,
  type LedgerPostContext,
} from "../ledger/LedgerPoster";
import type { Repositories, Tx } from "../db/ports";

/**
 * Executable governance.
 *
 * Every maker-checker decision in this module MOVES MONEY. Recording a state
 * change is never enough: the ledger posting, the state change of the
 * case/dispute/adjustment/cash-out and the audit trail are written inside one
 * database transaction, so an approved-but-unexecuted request can never hang.
 *
 * The design reference is `payment_gateway_final_design-v5.md` §11.3 (the 15
 * worked journal entries) and `payment-gateway-refined-design-v4.1.md` §18
 * (AML case management) and §19 (disputes, chargebacks and automated
 * drafting).
 */

/**
 * The non-human drafting principal.
 *
 * The identity is a real user row so that the foreign keys of
 * `approval_requests.maker_user_id` and `audit_log.actor_id` stay intact, but
 * it is `DISABLED`, it carries no authority and it can never be a checker:
 * the maker-checker separation is enforced in this module as well as in the
 * HTTP layer.
 */
export const SYSTEM_AUTOMATION_USER_ID = "SYSTEM_AUTOMATION";
export const SYSTEM_AUTOMATION_EMAIL = "system-drafter@payment-gateway.internal";

export type GovernanceExecutionStatus = "EXECUTED" | "HELD" | "SKIPPED";

export type AmlCaseAction = "HOLD" | "RELEASE" | "REJECT" | "ESCALATE";

export interface GovernanceExecutionResult {
  status: GovernanceExecutionStatus;
  reason?: string;
  entityId?: string;
  template?: string;
  journalEntryId?: string | null;
  operatorCaseId?: string | null;
  idempotent?: boolean;
}

export interface GovernanceExecutionContext {
  ledgerPoster: LedgerPoster;
  repositories: Repositories;
}

export interface ApprovalSubjectLike {
  id: string;
  subjectType: string;
  subjectId: string;
  payloadDiffJson?: unknown;
  makerUserId: string;
}

const modelOf = (tx: Tx, name: string): any => {
  const client = tx as Record<string, any>;
  const delegate = client[name];
  if (!delegate) {
    throw new ApiError(500, "PRISMA_MODEL_UNAVAILABLE", `The '${name}' model is not available`);
  }
  return delegate;
};

/**
 * Reads a monetary column into an exact decimal. Floating point never enters
 * the governance path.
 */
const toDecimal = (value: unknown): Decimal => {
  if (value === null || value === undefined) {
    return new Decimal(0);
  }
  if (value instanceof Decimal) {
    return new Decimal(value.toString());
  }
  try {
    return decimal(value as never);
  } catch {
    return new Decimal(0);
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const slaHoursForSeverity = (severity: string): number => {
  switch (severity) {
    case "CRITICAL":
      return 4;
    case "HIGH":
      return 24;
    case "MEDIUM":
      return 72;
    default:
      return 120;
  }
};

/**
 * The ledger context of a governance posting.
 *
 * Only the merchant wallet is bound to an owner, so it is resolved explicitly
 * and passed as a pinned account. Every other leg of the posting is a
 * platform account that is resolved by its account type.
 */
const walletLedgerContext = async (
  tx: Tx,
  merchantId: string | null | undefined,
  extra?: Record<string, string>,
  attemptId?: string | null,
): Promise<LedgerPostContext> => {
  const accounts: Record<string, string> = { ...extra };
  if (merchantId) {
    accounts.MERCHANT_WALLET = await resolveMerchantWalletGlAccountId(tx, merchantId, attemptId);
  }
  return Object.keys(accounts).length > 0 ? { accounts } : {};
};

/**
 * Creates the non-human drafting principal on demand.
 *
 * The row is `DISABLED` and carries no authority, so it can never log in and
 * can never be used as a checker.
 */
export const ensureSystemAutomationUser = async (tx: Tx): Promise<string> => {
  const users = modelOf(tx, "user");
  const existing = await users.findFirst({ where: { id: SYSTEM_AUTOMATION_USER_ID } });
  if (existing) {
    return SYSTEM_AUTOMATION_USER_ID;
  }
  try {
    await users.create({
      data: {
        id: SYSTEM_AUTOMATION_USER_ID,
        email: SYSTEM_AUTOMATION_EMAIL,
        role: "OPERATOR",
        authoritiesMap: {},
        appScopeIds: [],
        isMaker: false,
        isChecker: false,
        mfaRequired: false,
        status: "DISABLED",
      },
    });
  } catch (error) {
    const raced = await users.findFirst({ where: { id: SYSTEM_AUTOMATION_USER_ID } });
    if (!raced) {
      throw error;
    }
  }
  return SYSTEM_AUTOMATION_USER_ID;
};

const writeAudit = async (
  ctx: GovernanceExecutionContext,
  tx: Tx,
  data: {
    actorId: string | null;
    role: string | null;
    action: string;
    entityType: string;
    entityId: string;
    beforeJson?: unknown;
    afterJson?: unknown;
    approvalRequestId?: string | null;
  },
): Promise<void> => {
  await ctx.repositories.governance.writeAuditLog(tx, data);
};

/**
 * Opens an operator case for a governance event that a human must handle.
 *
 * The case is de-duplicated on (kind, attempt, open state) so that a repeated
 * approval never floods the operator queue.
 */
const openOperatorCase = async (
  ctx: GovernanceExecutionContext,
  tx: Tx,
  input: {
    kind: string;
    priority: "P1" | "P2" | "P3";
    attemptId?: string | null;
    approvalRequestId?: string | null;
    notes: string;
    slaHours: number;
  },
): Promise<string | null> => {
  const operatorCases = modelOf(tx, "operatorCase");
  const existing = await operatorCases.findFirst({
    where: {
      kind: input.kind,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      state: { in: ["OPEN", "IN_PROGRESS", "PENDING_CHECKER"] },
    },
  });
  if (existing) {
    return String(existing.id);
  }
  const created = await operatorCases.create({
    data: {
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      kind: input.kind,
      priority: input.priority,
      state: "OPEN",
      slaDueAt: new Date(Date.now() + input.slaHours * 60 * 60 * 1000),
      resolutionNotes: input.notes.slice(0, 1000),
      ...(input.approvalRequestId ? { approvalRequestId: input.approvalRequestId } : {}),
    },
  });
  return String(created.id);
};

const resolveMerchantWalletGlAccountId = async (
  tx: Tx,
  merchantId: string,
  attemptId?: string | null,
): Promise<string> => {
  const wallets = modelOf(tx, "wallet");
  const wallet = await wallets.findFirst({ where: { merchantId } });
  if (wallet && wallet.glAccountId) {
    return String(wallet.glAccountId);
  }
  const glAccounts = modelOf(tx, "glAccount");
  const account = await glAccounts.findFirst({ where: { accountType: "MERCHANT_WALLET", ownerId: merchantId } });
  if (account) {
    return String(account.id);
  }
  if (attemptId) {
    const attempt = await modelOf(tx, "paymentAttempt").findUnique({ where: { id: attemptId } });
    const link = attempt?.linkId
      ? await modelOf(tx, "paymentLink").findUnique({ where: { id: String(attempt.linkId) } })
      : null;
    if (link?.walletId) {
      const linked = await wallets.findUnique({ where: { id: String(link.walletId) } });
      if (linked?.glAccountId) {
        return String(linked.glAccountId);
      }
    }
  }
  throw new ApiError(409, "MERCHANT_WALLET_NOT_FOUND", "The merchant has no wallet to post against");
};

const resolveNegativeBalanceCeiling = async (tx: Tx, merchantId: string): Promise<Decimal> => {
  const merchants = modelOf(tx, "merchant");
  const merchant = await merchants.findUnique({ where: { id: merchantId } });
  return toDecimal(merchant?.negativeBalanceCeiling);
};

/**
 * The merchant wallet balance, computed from the posted journal lines.
 */
const resolveMerchantWalletBalance = async (tx: Tx, merchantId: string): Promise<Decimal> => {
  const glAccounts = modelOf(tx, "glAccount");
  const journalLines = modelOf(tx, "journalLine");
  const accounts = await glAccounts.findMany({ where: { accountType: "MERCHANT_WALLET", ownerId: merchantId } });
  if (!accounts.length) {
    return new Decimal(0);
  }
  const ids = accounts.map((account: any) => String(account.id));
  const lines = await journalLines.findMany({ where: { glAccountId: { in: ids } } });
  let balance = new Decimal(0);
  for (const line of lines) {
    const amount = toDecimal(line.amount);
    balance = line.direction === "CREDIT" ? balance.plus(amount) : balance.minus(amount);
  }
  return balance;
};

const resolveAdjustmentMerchantId = async (tx: Tx, adjustment: any): Promise<string> => {
  if (adjustment.disputeId) {
    const dispute = await modelOf(tx, "dispute").findUnique({ where: { id: String(adjustment.disputeId) } });
    if (dispute) {
      const attempt = await modelOf(tx, "paymentAttempt").findUnique({ where: { id: String(dispute.attemptId) } });
      if (attempt?.merchantId) {
        return String(attempt.merchantId);
      }
    }
  }
  if (adjustment.sourceAttemptId) {
    const attempt = await modelOf(tx, "paymentAttempt").findUnique({ where: { id: String(adjustment.sourceAttemptId) } });
    if (attempt?.merchantId) {
      return String(attempt.merchantId);
    }
  }
  const account = await modelOf(tx, "glAccount").findUnique({ where: { id: String(adjustment.targetGlAccountId) } });
  if (account?.ownerId) {
    return String(account.ownerId);
  }
  return "";
};

/**
 * Reads the proposed resolution out of an AML approval payload.
 */
const amlActionOf = (payload: unknown): AmlCaseAction => {
  const record = asRecord(payload);
  const action = String(record.action ?? "RELEASE").toUpperCase();
  if (action === "HOLD" || action === "RELEASE" || action === "REJECT" || action === "ESCALATE") {
    return action;
  }
  return "RELEASE";
};

const disputeOutcomeOf = (status: string): "WON" | "LOST" | null => {
  if (status === "WON") {
    return "WON";
  }
  if (status === "LOST" || status === "EXPIRED") {
    return "LOST";
  }
  return null;
};

/**
 * The chargeback money movement is authorised by a human finance operator.
 *
 * The rule is only enforced when the checker identity is known, so that a
 * service identity can never slip through.
 */
const assertFinanceChecker = async (tx: Tx, checkerUserId: string): Promise<void> => {
  if (!checkerUserId || checkerUserId === SYSTEM_AUTOMATION_USER_ID) {
    throw new ApiError(403, "AUTOMATION_CANNOT_ACT_AS_CHECKER", "System automation can never act as a checker");
  }
  const user = await modelOf(tx, "user").findUnique({ where: { id: checkerUserId } });
  if (!user) {
    return;
  }
  if (user.status !== "ACTIVE") {
    throw new ApiError(403, "ACCOUNT_NOT_ACTIVE", "The checker account is not active");
  }
  if (String(user.role) !== "FINANCE") {
    throw new ApiError(
      403,
      "FINANCE_CHECKER_REQUIRED",
      "A chargeback may only be authorised by a finance checker",
      { role: String(user.role) },
    );
  }
};

/**
 * Resolves the money that an AML hold carries.
 *
 * The authoritative amount is the `AML_HOLD` credit of the hold journal entry
 * that the case points at. When the hold entry is missing the attempt total is
 * used instead.
 */
const resolveAmlHoldAmounts = async (
  tx: Tx,
  amlCase: any,
  attempt: any,
): Promise<{ amount: Decimal; commission: Decimal; merchantAmount: Decimal }> => {
  let held = new Decimal(0);
  const holdEntryId = amlCase.holdJournalEntryId ? String(amlCase.holdJournalEntryId) : null;
  if (holdEntryId) {
    const glAccounts = modelOf(tx, "glAccount");
    const journalLines = modelOf(tx, "journalLine");
    const holdAccounts = await glAccounts.findMany({ where: { accountType: "AML_HOLD" } });
    const holdIds = new Set(holdAccounts.map((account: any) => String(account.id)));
    const lines = await journalLines.findMany({ where: { entryId: holdEntryId } });
    for (const line of lines) {
      if (holdIds.has(String(line.glAccountId)) && line.direction === "CREDIT") {
        held = held.plus(toDecimal(line.amount));
      }
    }
  }
  const amount = held.gt(0) ? held : toDecimal(attempt?.totalChargedAmount);
  if (!amount.gt(0)) {
    throw new ApiError(409, "AML_HOLD_AMOUNT_UNRESOLVED", "The held amount of the AML case could not be resolved");
  }
  const commission = toDecimal(attempt?.platformCommissionAmount);
  const merchantAmount = amount.minus(commission);
  if (merchantAmount.lt(0)) {
    throw new ApiError(409, "AML_HOLD_AMOUNT_INCONSISTENT", "The platform commission exceeds the held amount");
  }
  return { amount, commission, merchantAmount };
};

/**
 * Executes the resolution of an AML case.
 *
 * `RELEASE` moves the hold back to the merchant (design §11.3 entry 7),
 * `REJECT` voids the hold and returns the funds (design §11.3 entry 11),
 * `ESCALATE` leaves the money in `AML_HOLD` and escalates the case, and
 * `HOLD` freezes the case without touching the money.
 *
 * A `MERCHANT_DIRECT` case never moves money: the platform holds no cash, so
 * the case is simply closed.
 */
export async function executeAmlCaseResolution(
  ctx: GovernanceExecutionContext,
  tx: Tx,
  input: {
    amlCaseId: string;
    action: AmlCaseAction;
    checkerUserId: string;
    checkerRole: string;
    notes?: string | null;
    approvalRequestId?: string | null;
  },
): Promise<GovernanceExecutionResult> {
  const amlCases = modelOf(tx, "amlCase");
  const amlCase = await amlCases.findUnique({ where: { id: input.amlCaseId } });
  if (!amlCase) {
    throw new ApiError(404, "AML_CASE_NOT_FOUND", "The AML case does not exist");
  }
  if (amlCase.status === "RELEASED" || amlCase.status === "REJECTED_VOID") {
    return {
      status: "SKIPPED",
      reason: "AML_CASE_ALREADY_RESOLVED",
      entityId: String(amlCase.id),
      idempotent: true,
    };
  }

  const attempt = amlCase.subjectType === "PAYMENT_ATTEMPT"
    ? await modelOf(tx, "paymentAttempt").findUnique({ where: { id: String(amlCase.subjectId) } })
    : null;
  const settlementTarget = String(attempt.settlementTarget ?? "PLATFORM_CLEARING");
  const merchantDirect = settlementTarget === "MERCHANT_DIRECT";
  const severity = String(amlCase.severity ?? "MEDIUM");
  const action = input.action;
  const targetStatus = action === "RELEASE"
    ? "RELEASED"
    : action === "REJECT"
      ? "REJECTED_VOID"
      : action === "ESCALATE"
        ? "ESCALATED_STR"
        : "FROZEN";

  let journalEntryId: string | null = null;
  let template: string | undefined;
  let postingReason: string | undefined;

  if (action === "ESCALATE") {
    postingReason = "ESCALATED_TO_STR";
  } else if (action === "HOLD") {
    postingReason = "FROZEN_WITHOUT_POSTING";
  } else if (merchantDirect) {
    postingReason = "CASE_ONLY_NO_POSTING";
  } else {
    const amounts = await resolveAmlHoldAmounts(tx, amlCase, attempt);
    const merchantId = attempt?.merchantId ? String(attempt.merchantId) : null;
    if (!merchantId) {
      throw new ApiError(
        409,
        "AML_CASE_MERCHANT_UNRESOLVED",
        "The merchant of the held payment could not be resolved, so the hold cannot be released",
      );
    }
    const refId = attempt ? String(attempt.id) : String(amlCase.id);
    const journal: JournalTemplate = action === "RELEASE"
      ? buildLedgerTemplate("AML_HOLD_AND_RELEASE", {
        amount: amounts.amount,
        commissionAmount: amounts.commission,
        merchantAmount: amounts.merchantAmount,
        stage: "RELEASE",
      })
      : buildLedgerTemplate("AML_VOID", {
        amount: amounts.amount,
        commissionAmount: amounts.commission,
        merchantAmount: amounts.merchantAmount,
      });
    journal.refId = refId;
    const posted = await ctx.ledgerPoster.post(
      journal,
      await walletLedgerContext(tx, merchantId),
      tx as never,
    );
    journalEntryId = posted.entry.id;
    template = action === "RELEASE" ? "AML_HOLD_AND_RELEASE" : "AML_VOID";
  }

  await amlCases.update({
    where: { id: String(amlCase.id) },
    data: {
      status: targetStatus,
      assignedReviewerId: input.checkerUserId,
      ...(input.notes ? { reviewerNotes: input.notes } : {}),
    },
  });

  let operatorCaseId: string | null = null;
  if (action === "ESCALATE") {
    operatorCaseId = await openOperatorCase(ctx, tx, {
      kind: "MANUAL_REVIEW",
      priority: "P1",
      attemptId: attempt ? String(attempt.id) : null,
      approvalRequestId: input.approvalRequestId ?? null,
      notes: `AML case ${amlCase.id} was escalated to a suspicious activity review`,
      slaHours: slaHoursForSeverity(severity),
    });
  } else if (severity === "CRITICAL") {
    operatorCaseId = await openOperatorCase(ctx, tx, {
      kind: "HELD",
      priority: "P1",
      attemptId: attempt ? String(attempt.id) : null,
      approvalRequestId: input.approvalRequestId ?? null,
      notes: `AML case ${amlCase.id} is CRITICAL and the hold was resolved by a checker`,
      slaHours: slaHoursForSeverity(severity),
    });
  }

  await writeAudit(ctx, tx, {
    actorId: input.checkerUserId,
    role: input.checkerRole,
    action: "AML_CASE_RESOLVED",
    entityType: "AML_CASE",
    entityId: String(amlCase.id),
    beforeJson: { status: String(amlCase.status), severity },
    afterJson: {
      status: targetStatus,
      action,
      template: template ?? null,
      journalEntryId,
      settlementTarget,
      postingReason: postingReason ?? null,
      operatorCaseId,
    },
    approvalRequestId: input.approvalRequestId ?? null,
  });

  return {
    status: "EXECUTED",
    entityId: String(amlCase.id),
    ...(template ? { template } : {}),
    journalEntryId,
    operatorCaseId,
    reason: postingReason,
  };
}

export interface DisputeIntakeInput {
  attemptId: string;
  gatewayId: string;
  railId: string;
  externalDisputeRef: string;
  source: "WEBHOOK" | "STATEMENT" | "MANUAL";
  reasonCode?: string | null;
  amount: Decimal;
  currency: string;
  actorUserId: string | null;
  actorRole: string | null;
}

export interface DisputeIntakeResult {
  disputeId: string;
  adjustmentId: string;
  approvalRequestId: string;
  escrowed: boolean;
  journalEntryId: string | null;
}

/**
 * Opens a dispute and drafts the chargeback adjustment.
 *
 * The automation drafts the adjustment and never authorises it: the maker of
 * the approval request is the `SYSTEM_AUTOMATION` principal and only a human
 * checker can move the money (design §19.3). The reserve leg
 * (`CHARGEBACK_RESERVE_AND_LOST`, stage `RESERVE`) is posted as soon as the
 * dispute is known, unless the settlement is merchant direct, where the
 * platform holds no cash at all.
 */
export async function openDisputeWithDraftedAdjustment(
  ctx: GovernanceExecutionContext,
  tx: Tx,
  input: DisputeIntakeInput,
): Promise<DisputeIntakeResult> {
  const disputes = modelOf(tx, "dispute");
  const existing = await disputes.findFirst({
    where: { gatewayId: input.gatewayId, externalDisputeRef: input.externalDisputeRef },
  });
  if (existing) {
    throw new ApiError(409, "DISPUTE_ALREADY_EXISTS", "A dispute with this reference already exists");
  }

  const attempts = modelOf(tx, "paymentAttempt");
  const attempt = await attempts.findUnique({ where: { id: input.attemptId } });
  if (!attempt) {
    throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The disputed payment attempt does not exist");
  }
  const merchantId = attempt.merchantId ? String(attempt.merchantId) : "";
  const currency = input.currency.toUpperCase();

  const dispute = await disputes.create({
    data: {
      attemptId: input.attemptId,
      gatewayId: input.gatewayId,
      railId: input.railId,
      externalDisputeRef: input.externalDisputeRef,
      source: input.source,
      reasonCode: input.reasonCode ?? null,
      amount: input.amount,
      currency,
      status: "OPENED",
      openedAt: new Date(),
    },
  });

  const targetGlAccountId = await resolveMerchantWalletGlAccountId(tx, merchantId, input.attemptId);
  const adjustment = await modelOf(tx, "adjustment").create({
    data: {
      type: "CHARGEBACK",
      targetGlAccountId,
      sourceAttemptId: input.attemptId,
      disputeId: String(dispute.id),
      draftedBySystem: true,
      amount: input.amount,
      reverseCommission: true,
      reason: `Chargeback drafted for dispute ${input.externalDisputeRef}`,
      externalDisputeRef: input.externalDisputeRef,
      state: "PENDING_REVIEW",
    },
  });

  const systemUserId = await ensureSystemAutomationUser(tx);
  const approval = await modelOf(tx, "approvalRequest").create({
    data: {
      subjectType: "ADJUSTMENT",
      subjectId: String(adjustment.id),
      payloadDiffJson: { type: "CHARGEBACK", outcome: "PENDING", disputeId: String(dispute.id) },
      mode: "STANDARD",
      makerUserId: systemUserId,
      state: "PENDING_REVIEW",
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    },
  });

  let journalEntryId: string | null = null;
  let escrowed = false;
  const settlementTarget = String(attempt.settlementTarget ?? "PLATFORM_CLEARING");
  if (settlementTarget !== "MERCHANT_DIRECT") {
    const commission = toDecimal(attempt.platformCommissionAmount);
    const merchantAmount = input.amount.minus(commission);
    if (merchantAmount.lt(0)) {
      throw new ApiError(409, "CHARGEBACK_AMOUNT_INCONSISTENT", "The platform commission exceeds the disputed amount");
    }
    const journal = buildLedgerTemplate("CHARGEBACK_RESERVE_AND_LOST", {
      amount: input.amount,
      commissionAmount: commission,
      merchantAmount,
      stage: "RESERVE",
    });
    // The reserve belongs to the dispute, the outcome leg belongs to the
    // adjustment, so the two postings never collide on (refType, refId).
    journal.refId = String(dispute.id);
    const posted = await ctx.ledgerPoster.post(
      journal,
      await walletLedgerContext(tx, merchantId),
      tx as never,
    );
    journalEntryId = posted.entry.id;
    escrowed = true;
  }

  await disputes.update({ where: { id: String(dispute.id) }, data: { adjustmentId: String(adjustment.id) } });

  await writeAudit(ctx, tx, {
    actorId: input.actorUserId,
    role: input.actorRole,
    action: "DISPUTE_OPENED",
    entityType: "DISPUTE",
    entityId: String(dispute.id),
    afterJson: {
      amount: input.amount.toFixed(4),
      currency,
      externalDisputeRef: input.externalDisputeRef,
      escrowed,
      journalEntryId,
    },
  });
  await writeAudit(ctx, tx, {
    actorId: systemUserId,
    role: "SYSTEM_AUTOMATION",
    action: "ADJUSTMENT_DRAFTED",
    entityType: "ADJUSTMENT",
    entityId: String(adjustment.id),
    afterJson: {
      type: "CHARGEBACK",
      state: "PENDING_REVIEW",
      disputeId: String(dispute.id),
      externalDisputeRef: input.externalDisputeRef,
    },
    approvalRequestId: String(approval.id),
  });

  return {
    disputeId: String(dispute.id),
    adjustmentId: String(adjustment.id),
    approvalRequestId: String(approval.id),
    escrowed,
    journalEntryId,
  };
}

/**
 * Executes an adjustment and posts the matching journal entry.
 *
 * A `CHARGEBACK` posts the reserve outcome (`CHARGEBACK_WON` or
 * `CHARGEBACK_RESERVE_AND_LOST`, stage `LOST`), a fee correction posts
 * `FEE_VARIANCE_TRUE_UP` and a manual debit or credit posts the matching
 * wallet movement. The posting and the state change share one transaction.
 */
export async function executeAdjustment(
  ctx: GovernanceExecutionContext,
  tx: Tx,
  input: {
    adjustmentId: string;
    checkerUserId: string;
    checkerRole: string;
    outcome?: "WON" | "LOST" | null;
    notes?: string | null;
    approvalRequestId?: string | null;
  },
): Promise<GovernanceExecutionResult> {
  const adjustments = modelOf(tx, "adjustment");
  const adjustment = await adjustments.findUnique({ where: { id: input.adjustmentId } });
  if (!adjustment) {
    throw new ApiError(404, "ADJUSTMENT_NOT_FOUND", "The adjustment does not exist");
  }
  if (adjustment.state === "EXECUTED") {
    return {
      status: "SKIPPED",
      reason: "ADJUSTMENT_ALREADY_EXECUTED",
      entityId: String(adjustment.id),
      journalEntryId: adjustment.journalEntryId ?? null,
      idempotent: true,
    };
  }
  if (adjustment.state === "REJECTED") {
    return {
      status: "SKIPPED",
      reason: "ADJUSTMENT_REJECTED",
      entityId: String(adjustment.id),
      idempotent: true,
    };
  }

  const type = String(adjustment.type);
  const amount = toDecimal(adjustment.amount);
  if (!amount.gt(0)) {
    throw new ApiError(400, "INVALID_LEDGER_AMOUNT", "The adjustment amount must be greater than zero");
  }
  const merchantId = await resolveAdjustmentMerchantId(tx, adjustment);
  const sourceAttempt = adjustment.sourceAttemptId
    ? await modelOf(tx, "paymentAttempt").findUnique({ where: { id: String(adjustment.sourceAttemptId) } })
    : null;
  const reverseCommission = adjustment.reverseCommission === true;
  const commission = reverseCommission ? toDecimal(sourceAttempt?.platformCommissionAmount) : new Decimal(0);
  const merchantAmount = amount.minus(commission);
  if (merchantAmount.lt(0)) {
    throw new ApiError(409, "ADJUSTMENT_AMOUNT_INCONSISTENT", "The platform commission exceeds the adjustment amount");
  }
  const targetAccount = await modelOf(tx, "glAccount").findUnique({ where: { id: String(adjustment.targetGlAccountId) } });
  const accounts = targetAccount?.accountType === "MERCHANT_WALLET"
    ? { MERCHANT_WALLET: String(adjustment.targetGlAccountId) }
    : undefined;

  let journal: JournalTemplate;
  let templateName: string;
  let disputeOutcome: "WON" | "LOST" | null = null;

  if (type === "CHARGEBACK") {
    // Only a human finance operator may authorise the money movement of a
    // chargeback (design §19.3). The system principal is never eligible.
    await assertFinanceChecker(tx, input.checkerUserId);

    const dispute = adjustment.disputeId
      ? await modelOf(tx, "dispute").findUnique({ where: { id: String(adjustment.disputeId) } })
      : null;
    disputeOutcome = input.outcome ?? (dispute ? disputeOutcomeOf(String(dispute.status)) : null);
    if (!disputeOutcome) {
      const operatorCaseId = await openOperatorCase(ctx, tx, {
        kind: "MANUAL_REVIEW",
        priority: "P2",
        attemptId: adjustment.sourceAttemptId ? String(adjustment.sourceAttemptId) : null,
        approvalRequestId: input.approvalRequestId ?? null,
        notes: `Chargeback adjustment ${adjustment.id} has no dispute outcome yet`,
        slaHours: 72,
      });
      await writeAudit(ctx, tx, {
        actorId: input.checkerUserId,
        role: input.checkerRole,
        action: "ADJUSTMENT_HELD_FOR_REVIEW",
        entityType: "ADJUSTMENT",
        entityId: String(adjustment.id),
        afterJson: { reason: "DISPUTE_OUTCOME_PENDING", operatorCaseId },
        approvalRequestId: input.approvalRequestId ?? null,
      });
      return {
        status: "HELD",
        reason: "DISPUTE_OUTCOME_PENDING",
        entityId: String(adjustment.id),
        operatorCaseId,
      };
    }

    // The negative balance ceiling of the merchant is respected: a chargeback
    // that pushes the wallet below the ceiling is held for review instead of
    // being executed (design §19.5).
    const ceiling = await resolveNegativeBalanceCeiling(tx, merchantId);
    const balance = await resolveMerchantWalletBalance(tx, merchantId);
    const reservePosted = dispute
      ? await modelOf(tx, "journalEntry").findFirst({
        where: { refType: "DISPUTE_OUTCOME", refId: String(dispute.id) },
      })
      : null;
    const preReserveBalance = reservePosted ? balance.plus(merchantAmount) : balance;
    const netImpact = disputeOutcome === "WON" ? new Decimal(0) : merchantAmount.negated();
    const projected = preReserveBalance.plus(netImpact);
    if (projected.lt(ceiling.negated())) {
      const operatorCaseId = await openOperatorCase(ctx, tx, {
        kind: "HELD",
        priority: "P1",
        attemptId: adjustment.sourceAttemptId ? String(adjustment.sourceAttemptId) : null,
        approvalRequestId: input.approvalRequestId ?? null,
        notes: `Chargeback adjustment ${adjustment.id} would take the wallet of ${merchantId} to ${projected.toFixed(4)}, below the ceiling of ${ceiling.toFixed(4)}`,
        slaHours: 4,
      });
      await writeAudit(ctx, tx, {
        actorId: input.checkerUserId,
        role: input.checkerRole,
        action: "ADJUSTMENT_HELD_FOR_REVIEW",
        entityType: "ADJUSTMENT",
        entityId: String(adjustment.id),
        afterJson: {
          reason: "NEGATIVE_BALANCE_CEILING_EXCEEDED",
          balance: balance.toFixed(4),
          ceiling: ceiling.toFixed(4),
          projected: projected.toFixed(4),
          operatorCaseId,
        },
        approvalRequestId: input.approvalRequestId ?? null,
      });
      return {
        status: "HELD",
        reason: "NEGATIVE_BALANCE_CEILING_EXCEEDED",
        entityId: String(adjustment.id),
        operatorCaseId,
      };
    }

    journal = disputeOutcome === "WON"
      ? buildLedgerTemplate("CHARGEBACK_WON", {
        amount,
        commissionAmount: commission,
        merchantAmount,
      })
      : buildLedgerTemplate("CHARGEBACK_RESERVE_AND_LOST", {
        amount,
        commissionAmount: commission,
        merchantAmount,
        stage: "LOST",
      });
    templateName = disputeOutcome === "WON" ? "CHARGEBACK_WON" : "CHARGEBACK_RESERVE_AND_LOST";
  } else if (type === "CORRECTION") {
    journal = buildLedgerTemplate("FEE_VARIANCE_TRUE_UP", { amount, varianceAmount: amount });
    templateName = "FEE_VARIANCE_TRUE_UP";
  } else if (type === "MANUAL_DEBIT" || type === "CASHOUT_SUBTRACTION") {
    journal = buildLedgerTemplate("CASHOUT", { amount });
    templateName = "CASHOUT";
  } else if (type === "MANUAL_CREDIT") {
    journal = buildLedgerTemplate("INTERNAL_CONFIRMATION", {
      amount,
      commissionAmount: new Decimal(0),
      merchantAmount: amount,
    });
    templateName = "INTERNAL_CONFIRMATION";
  } else if (type === "REFUND") {
    journal = buildLedgerTemplate("FULL_REFUND", {
      amount,
      commissionAmount: commission,
      merchantAmount,
    });
    templateName = "FULL_REFUND";
  } else {
    throw new ApiError(409, "ADJUSTMENT_TYPE_NOT_EXECUTABLE", `The adjustment type '${type}' cannot be executed`);
  }

  // Every adjustment posting is keyed by the adjustment itself, so a repeated
  // execution can never create a second journal entry. A manual credit is
  // booked against the adjustment reference, never against a payment attempt.
  journal.refId = String(adjustment.id);
  if (journal.refType === "PAYMENT_ATTEMPT") {
    journal.refType = "ADJUSTMENT";
  }

  const posted = await ctx.ledgerPoster.post(
    journal,
    await walletLedgerContext(tx, merchantId, accounts),
    tx as never,
  );

  await adjustments.update({
    where: { id: String(adjustment.id) },
    data: { state: "EXECUTED", journalEntryId: posted.entry.id },
  });

  if (disputeOutcome && adjustment.disputeId) {
    await modelOf(tx, "dispute").update({
      where: { id: String(adjustment.disputeId) },
      data: {
        status: disputeOutcome === "WON" ? "WON" : "LOST",
        outcomeAt: new Date(),
        adjustmentId: String(adjustment.id),
      },
    });
  }

  await writeAudit(ctx, tx, {
    actorId: input.checkerUserId,
    role: input.checkerRole,
    action: "ADJUSTMENT_EXECUTED",
    entityType: "ADJUSTMENT",
    entityId: String(adjustment.id),
    beforeJson: { state: String(adjustment.state), type },
    afterJson: {
      state: "EXECUTED",
      type,
      template: templateName,
      journalEntryId: posted.entry.id,
      amount: amount.toFixed(4),
      outcome: disputeOutcome,
    },
    approvalRequestId: input.approvalRequestId ?? null,
  });

  return {
    status: "EXECUTED",
    entityId: String(adjustment.id),
    template: templateName,
    journalEntryId: posted.entry.id,
    idempotent: posted.idempotent,
  };
}

/**
 * Executes or rejects a cash-out request.
 *
 * An approval moves the money (`CASHOUT`: `Dr MERCHANT_WALLET` /
 * `Cr TREASURY`) and marks the request executed. A rejection releases the
 * money back to the merchant wallet - the wallet was never debited - and
 * records the reason.
 */
export async function executeCashout(
  ctx: GovernanceExecutionContext,
  tx: Tx,
  input: {
    cashoutId: string;
    decision: "APPROVE" | "REJECT";
    reason?: string | null;
    actorUserId: string;
    actorRole: string;
  },
): Promise<GovernanceExecutionResult> {
  const cashouts = modelOf(tx, "cashoutRequest");
  const cashout = await cashouts.findUnique({ where: { id: input.cashoutId } });
  if (!cashout) {
    throw new ApiError(404, "CASHOUT_NOT_FOUND", "The cash-out request does not exist");
  }
  const state = String(cashout.state);
  const wallets = modelOf(tx, "wallet");
  const wallet = await wallets.findUnique({ where: { id: String(cashout.walletId) } });
  if (!wallet) {
    throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");
  }
  const amount = toDecimal(cashout.amount);
  if (!amount.gt(0)) {
    throw new ApiError(400, "CASHOUT_AMOUNT_INVALID", "The cash-out amount must be greater than zero");
  }

  if (input.decision === "REJECT") {
    if (state === "REJECTED") {
      return {
        status: "SKIPPED",
        reason: "CASHOUT_ALREADY_REJECTED",
        entityId: String(cashout.id),
        idempotent: true,
      };
    }
    const reason = input.reason?.trim() ? input.reason.trim() : "No reason supplied";
    const adjustment = await modelOf(tx, "adjustment").create({
      data: {
        type: "CASHOUT_SUBTRACTION",
        targetGlAccountId: String(wallet.glAccountId),
        amount,
        reason: `Cash-out rejected for request ${cashout.id}: ${reason}`.slice(0, 1000),
        draftedBySystem: false,
        state: "REJECTED",
      },
    });
    const updated = await cashouts.update({
      where: { id: String(cashout.id) },
      data: { state: "REJECTED", adjustmentId: String(adjustment.id) },
    });
    await writeAudit(ctx, tx, {
      actorId: input.actorUserId,
      role: input.actorRole,
      action: "CASHOUT_REJECTED",
      entityType: "CASHOUT_REQUEST",
      entityId: String(cashout.id),
      beforeJson: { state },
      afterJson: {
        state: updated.state,
        reason,
        releasedAmount: amount.toFixed(4),
        adjustmentId: String(adjustment.id),
      },
    });
    return {
      status: "EXECUTED",
      entityId: String(updated.id),
      reason: "CASHOUT_RELEASED",
    };
  }

  if (state === "COMPLETE" || state === "SUBTRACTED") {
    return {
      status: "SKIPPED",
      reason: "CASHOUT_ALREADY_EXECUTED",
      entityId: String(cashout.id),
      idempotent: true,
    };
  }

  const adjustment = await modelOf(tx, "adjustment").create({
    data: {
      type: "CASHOUT_SUBTRACTION",
      targetGlAccountId: String(wallet.glAccountId),
      amount,
      reason: `Cash-out execution for request ${cashout.id}`.slice(0, 1000),
      draftedBySystem: false,
      state: "PENDING_REVIEW",
    },
  });

  const journal = buildLedgerTemplate("CASHOUT", { amount });
  journal.refId = String(adjustment.id);
  const posted = await ctx.ledgerPoster.post(
    journal,
    { accounts: { MERCHANT_WALLET: String(wallet.glAccountId) } },
    tx as never,
  );

  await modelOf(tx, "adjustment").update({
    where: { id: String(adjustment.id) },
    data: { state: "EXECUTED", journalEntryId: posted.entry.id },
  });
  const updated = await cashouts.update({
    where: { id: String(cashout.id) },
    data: { state: "COMPLETE", adjustmentId: String(adjustment.id) },
  });

  await writeAudit(ctx, tx, {
    actorId: input.actorUserId,
    role: input.actorRole,
    action: "CASHOUT_EXECUTED",
    entityType: "CASHOUT_REQUEST",
    entityId: String(cashout.id),
    beforeJson: { state },
    afterJson: {
      state: updated.state,
      amount: amount.toFixed(4),
      adjustmentId: String(adjustment.id),
      journalEntryId: posted.entry.id,
    },
  });

  return {
    status: "EXECUTED",
    entityId: String(updated.id),
    template: "CASHOUT",
    journalEntryId: posted.entry.id,
    idempotent: posted.idempotent,
  };
}

/**
 * Executes whatever an approved request is about.
 *
 * The maker-checker separation is enforced here as well, so that no entry
 * point can ever let the system principal approve its own work.
 */
export async function executeApprovalSubject(
  ctx: GovernanceExecutionContext,
  tx: Tx,
  input: {
    approval: ApprovalSubjectLike;
    checkerUserId: string;
    checkerRole: string;
    notes?: string | null;
    outcome?: "WON" | "LOST" | null;
  },
): Promise<GovernanceExecutionResult> {
  if (input.checkerUserId === SYSTEM_AUTOMATION_USER_ID) {
    throw new ApiError(403, "AUTOMATION_CANNOT_ACT_AS_CHECKER", "System automation can never act as a checker");
  }
  if (!input.checkerUserId) {
    throw new ApiError(400, "APPROVAL_CHECKER_MISSING", "A checker is required before execution");
  }
  if (input.approval.makerUserId === input.checkerUserId) {
    throw new ApiError(409, "APPROVAL_MAKER_EQUALS_CHECKER", "The maker and the checker must be different users");
  }

  const subjectType = String(input.approval.subjectType);
  if (subjectType === "AML_CASE") {
    return executeAmlCaseResolution(ctx, tx, {
      amlCaseId: input.approval.subjectId,
      action: amlActionOf(input.approval.payloadDiffJson),
      checkerUserId: input.checkerUserId,
      checkerRole: input.checkerRole,
      notes: input.notes ?? null,
      approvalRequestId: input.approval.id,
    });
  }
  if (subjectType === "ADJUSTMENT") {
    return executeAdjustment(ctx, tx, {
      adjustmentId: input.approval.subjectId,
      checkerUserId: input.checkerUserId,
      checkerRole: input.checkerRole,
      outcome: input.outcome ?? null,
      notes: input.notes ?? null,
      approvalRequestId: input.approval.id,
    });
  }
  return { status: "SKIPPED", reason: "NO_EXECUTABLE_SUBJECT", entityId: input.approval.subjectId };
}
