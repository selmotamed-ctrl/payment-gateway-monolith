import { Decimal } from "decimal.js";
import { ApiError } from "../../lib/error";
import { moneyToString, type Money } from "../db/money";
import {
  buildLedgerTemplate,
  decimal,
  LedgerPoster,
  type JournalTemplate,
  type LedgerPostContext,
} from "../ledger/LedgerPoster";
import type { Repositories, Tx } from "../db/ports";
import { applyJsonPatch, validateJsonPatch, type JsonPatchOperation } from "./ApprovalService";
import {
  GoLiveGateValidator,
  type ChannelVerificationEvidence,
  type GoLiveValidationResult,
} from "../flow/GoLiveGateValidator";
import { ATTEMPT_TRANSITION_TOPIC } from "../flow/DynamicRailEngine";
import type { InvalidationBus } from "../../lib/invalidationBus";

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

export interface RefundExecutionEngine {
  refund(
    attempt: unknown,
    amount: Decimal,
    adjustmentId: string,
  ): Promise<{ status: string; attempt?: { ownershipMode?: string | null } | null }>;
}

export interface ReconciliationSchedulerLike {
  schedule(attemptId: string, adjustmentId?: string): Promise<void> | void;
}

export interface GovernanceExecutionContext {
  ledgerPoster: LedgerPoster;
  repositories: Repositories;
  /**
   * The universal rail engine. A refund is executed by the gateway first and
   * only booked when the gateway confirms it (design §8.2).
   */
  engine?: RefundExecutionEngine;
  /**
   * Schedules an attempt whose refund answer is UNKNOWN for reconciliation.
   */
  reconciliationScheduler?: ReconciliationSchedulerLike;
  /**
   * Optional outbound bus. When present, a governance driven attempt
   * transition (an AML release or void) is broadcast exactly like a normal
   * engine transition.
   */
  transitionBus?: Pick<InvalidationBus, "publish">;
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

const moneyToDecimal = (value: Money): Decimal => new Decimal(moneyToString(value));

const lockAttemptForGovernance = async (
  ctx: GovernanceExecutionContext,
  tx: Tx,
  attemptId: string,
): Promise<any> => {
  const lock = ctx.repositories.payments.lockAttemptById;
  if (lock) {
    return lock(tx, attemptId);
  }
  return modelOf(tx, "paymentAttempt").findUnique({ where: { id: attemptId } });
};

const sumGovernanceRefunds = async (
  ctx: GovernanceExecutionContext,
  tx: Tx,
  attemptId: string,
  states: string[],
): Promise<Decimal> => {
  const sum = ctx.repositories.disputes.sumRefundsForAttempt;
  if (sum) {
    return moneyToDecimal(await sum(tx, attemptId, states));
  }
  const adjustments = await modelOf(tx, "adjustment").findMany({
    where: { sourceAttemptId: attemptId, type: "REFUND", state: { in: states } },
  });
  let total = new Decimal(0);
  for (const row of adjustments as any[]) {
    total = total.plus(toDecimal(row.amount));
  }
  return total;
};

const capabilitiesOf = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asRecord(value);
};

const refundWindowDaysOf = async (
  tx: Tx,
  attempt: any,
  rail: any,
): Promise<number | null> => {
  const fromRail = rail?.refundWindowDays;
  if (fromRail !== null && fromRail !== undefined) {
    const days = Number(fromRail);
    if (Number.isFinite(days) && days >= 0) {
      return days;
    }
  }
  if (attempt?.routeId) {
    const route = await modelOf(tx, "railRoute").findUnique({
      where: { id: String(attempt.routeId) },
    });
    const scope = asRecord(route?.scope);
    const fromScope = scope.refund_window_days ?? scope.refundWindowDays;
    if (fromScope !== null && fromScope !== undefined) {
      const days = Number(fromScope);
      if (Number.isFinite(days) && days >= 0) {
        return days;
      }
    }
  }
  return null;
};

const assertRefundAllowedByRail = async (
  tx: Tx,
  attempt: any,
  amount: Decimal,
  refundableAmount: Decimal,
): Promise<void> => {
  if (!attempt?.railId) {
    return;
  }
  const rail = await modelOf(tx, "rail").findUnique({ where: { id: String(attempt.railId) } });
  if (!rail) {
    return;
  }
  const capabilities = capabilitiesOf(rail.capabilities);
  if (amount.lt(refundableAmount)) {
    if (capabilities.partial_refund !== true) {
      throw new ApiError(
        409,
        "PARTIAL_REFUND_NOT_SUPPORTED",
        "The pinned rail does not support partial refunds",
        { railId: String(attempt.railId) },
      );
    }
  } else if (capabilities.refund !== true) {
    throw new ApiError(
      409,
      "REFUND_NOT_SUPPORTED",
      "The pinned rail does not support refunds",
      { railId: String(attempt.railId) },
    );
  }

  const windowDays = await refundWindowDaysOf(tx, attempt, rail);
  if (windowDays === null) {
    return;
  }
  const base = attempt.terminalAt ?? attempt.createdAt;
  if (!base) {
    return;
  }
  const baseTime = new Date(base).getTime();
  if (!Number.isFinite(baseTime)) {
    return;
  }
  const deadline = baseTime + windowDays * 24 * 60 * 60 * 1000;
  if (Date.now() > deadline) {
    throw new ApiError(
      409,
      "REFUND_WINDOW_EXPIRED",
      `The ${windowDays}-day refund window of the pinned rail has expired`,
      { railId: String(attempt.railId), windowDays, deadline: new Date(deadline).toISOString() },
    );
  }
};

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

export type CommissionReceivableDecision = "ALLOW" | "PAUSE" | "NETTING";

export interface CommissionReceivableCeilingEvaluation {
  merchantId: string;
  receivable: Decimal;
  ceiling: Decimal | null;
  exceeded: boolean;
  decision: CommissionReceivableDecision;
  reason:
    | "NO_CEILING"
    | "WITHIN_CEILING"
    | "CEILING_EXCEEDED_PAUSE"
    | "CEILING_EXCEEDED_NETTING";
}

export const decideCommissionReceivableCeiling = (input: {
  merchantId: string;
  receivable: Decimal;
  ceiling: Decimal | null;
  settlementTarget?: string | null;
}): CommissionReceivableCeilingEvaluation => {
  const exceeded = input.ceiling !== null && input.receivable.gt(input.ceiling);
  if (!exceeded) {
    return {
      merchantId: input.merchantId,
      receivable: input.receivable,
      ceiling: input.ceiling,
      exceeded: false,
      decision: "ALLOW",
      reason: input.ceiling === null ? "NO_CEILING" : "WITHIN_CEILING",
    };
  }
  const netting = input.settlementTarget === "MERCHANT_DIRECT";
  return {
    merchantId: input.merchantId,
    receivable: input.receivable,
    ceiling: input.ceiling,
    exceeded: true,
    decision: netting ? "NETTING" : "PAUSE",
    reason: netting ? "CEILING_EXCEEDED_NETTING" : "CEILING_EXCEEDED_PAUSE",
  };
};

export const evaluateCommissionReceivableCeiling = async (
  ctx: Pick<GovernanceExecutionContext, "repositories">,
  tx: Tx,
  merchantId: string,
  settlementTarget?: string | null,
): Promise<CommissionReceivableCeilingEvaluation> => {
  const merchant = await ctx.repositories.merchants.findMerchantById(tx, merchantId);
  const rawCeiling = merchant?.commissionReceivableCeiling;
  const ceiling = rawCeiling === null || rawCeiling === undefined ? null : toDecimal(rawCeiling);
  const receivableQuery = ctx.repositories.merchants.getCommissionReceivableBalance;
  const receivable = receivableQuery
    ? moneyToDecimal(await receivableQuery(tx, merchantId))
    : new Decimal(0);
  return decideCommissionReceivableCeiling({
    merchantId,
    receivable,
    ceiling,
    settlementTarget: settlementTarget ?? null,
  });
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

export interface JoinRequestActivationInput {
  joinRequestId: string;
  checkerUserId: string;
  checkerRole: string;
  approvalRequestId?: string | null;
  decisionReasonCode?: string | null;
  decisionNotes?: string | null;
  proposedRiskTier?: string | null;
}

/**
 * Activates a merchant whose join request was approved.
 *
 * The four-eyes path (design §18) and the ordinary single-reviewer path both
 * call THIS function, so a merchant can never be activated by one path in a
 * way the other does not reproduce.
 */
export async function activateApprovedJoinRequest(
  ctx: GovernanceExecutionContext,
  tx: Tx,
  input: JoinRequestActivationInput,
): Promise<{ joinRequestId: string; merchantId: string; status: "APPROVED" }> {
  const joinRequests = modelOf(tx, "joinRequest");
  const joinRequest = await joinRequests.findUnique({ where: { id: input.joinRequestId } });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  const merchantId = String(joinRequest.merchantId);
  const merchants = modelOf(tx, "merchant");
  const merchant = await merchants.findUnique({ where: { id: merchantId } });
  if (!merchant) {
    throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  }
  if (joinRequest.status === "APPROVED" && merchant.status === "ACTIVE") {
    return { joinRequestId: String(joinRequest.id), merchantId, status: "APPROVED" };
  }

  const riskTier = input.proposedRiskTier ?? joinRequest.proposedRiskTier ?? merchant.riskTier;
  const activatedAt = new Date();
  await joinRequests.update({
    where: { id: String(joinRequest.id) },
    data: {
      status: "APPROVED",
      decision: "APPROVED",
      decisionReasonCode: input.decisionReasonCode ?? null,
      decisionNotes: input.decisionNotes ?? null,
      proposedRiskTier: riskTier,
    },
  });
  await merchants.update({
    where: { id: merchantId },
    data: {
      status: "ACTIVE",
      kybStatus: "VERIFIED",
      riskTier,
      activatedAt,
    },
  });

  // A self-service registration already created the wallet, but an approved
  // merchant must never be left without one: the wallet is created and
  // activated here when it is missing.
  const wallets = modelOf(tx, "wallet");
  const merchantWallets = await wallets.findMany({ where: { merchantId } });
  if (merchantWallets.length === 0) {
    const glAccounts = modelOf(tx, "glAccount");
    const glAccount = await glAccounts.create({
      data: {
        accountType: "MERCHANT_WALLET",
        ownerId: merchantId,
        currency: "LYD",
        checkpointBalance: 0,
      },
    });
    await wallets.create({
      data: {
        merchantId,
        glAccountId: String(glAccount.id),
        currency: "LYD",
        status: "PENDING",
      },
    });
  }
  await wallets.updateMany({ where: { merchantId }, data: { status: "ACTIVE" } });

  await writeAudit(ctx, tx, {
    actorId: input.checkerUserId,
    role: input.checkerRole,
    action: "JOIN_REQUEST_APPROVED",
    entityType: "JOIN_REQUEST",
    entityId: String(joinRequest.id),
    beforeJson: { status: String(joinRequest.status), merchantStatus: String(merchant.status) },
    afterJson: {
      status: "APPROVED",
      merchantId,
      merchantStatus: "ACTIVE",
      kybStatus: "VERIFIED",
      riskTier,
      activatedAt: activatedAt.toISOString(),
    },
    approvalRequestId: input.approvalRequestId ?? null,
  });

  return { joinRequestId: String(joinRequest.id), merchantId, status: "APPROVED" };
}

const decodePointerSegment = (segment: string): string =>
  segment.replaceAll("~1", "/").replaceAll("~0", "~");

const topLevelFieldOfPointer = (path: string): string => {
  if (!path.startsWith("/")) {
    return "";
  }
  const segment = path.slice(1).split("/")[0] ?? "";
  return decodePointerSegment(segment);
};

const readPointerValue = (root: unknown, path: string): unknown => {
  if (path === "") {
    return root;
  }
  let current: unknown = root;
  for (const raw of path.slice(1).split("/")) {
    const segment = decodePointerSegment(raw);
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const stringifyChangeValue = (value: unknown): string | null => {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const MERCHANT_DECIMAL_FIELDS = new Set([
  "negativeBalanceCeiling",
  "commissionReceivableCeiling",
]);
const MERCHANT_DATE_FIELDS = new Set(["activatedAt", "suspendedAt", "closedAt"]);

/**
 * Applies an approved merchant JSON-Patch.
 *
 * The patch is applied to the merchant row, every changed field is recorded
 * in `detail_change_logs` and the whole change is audited. The patch and the
 * audit share the approval transaction.
 */
export async function executeMerchantPatch(
  ctx: GovernanceExecutionContext,
  tx: Tx,
  input: {
    approvalId: string;
    merchantId: string;
    patch: unknown;
    checkerUserId: string;
    checkerRole: string;
  },
): Promise<GovernanceExecutionResult> {
  const operations = validateJsonPatch(input.patch);
  const merchants = modelOf(tx, "merchant");
  const merchant = await merchants.findUnique({ where: { id: input.merchantId } });
  if (!merchant) {
    throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  }

  // A Prisma Decimal is not structured-cloneable, so the patch document is
  // built from clone-safe values. Decimal fields touched by the patch are
  // converted back to an exact Decimal before the update.
  const before: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merchant as Record<string, unknown>)) {
    before[key] = value instanceof Decimal ? value.toString() : value;
  }
  const after = applyJsonPatch(before, operations as JsonPatchOperation[]);
  const touched = new Set(
    operations
      .map((operation) => topLevelFieldOfPointer(operation.path))
      .filter((field) => field.length > 0),
  );
  const data: Record<string, unknown> = {};
  for (const field of touched) {
    if (field === "id" || field === "createdAt" || field === "updatedAt") {
      continue;
    }
    const value = (after as Record<string, unknown>)[field];
    if (MERCHANT_DECIMAL_FIELDS.has(field)) {
      data[field] = value === null || value === undefined ? null : decimal(value as never);
    } else if (MERCHANT_DATE_FIELDS.has(field)) {
      data[field] = value === null || value === undefined ? null : new Date(String(value));
    } else {
      data[field] = value;
    }
  }
  if (Object.keys(data).length === 0) {
    return {
      status: "SKIPPED",
      reason: "MERCHANT_PATCH_EMPTY",
      entityId: input.merchantId,
      idempotent: true,
    };
  }
  const updated = await merchants.update({ where: { id: input.merchantId }, data });

  const detailLogs = modelOf(tx, "detailChangeLog");
  for (const operation of operations) {
    await detailLogs.create({
      data: {
        actorId: input.checkerUserId,
        merchantId: input.merchantId,
        entityType: "MERCHANT",
        entityId: input.merchantId,
        fieldName: operation.path,
        oldValue: stringifyChangeValue(readPointerValue(before, operation.path)),
        newValue: stringifyChangeValue(readPointerValue(after, operation.path)),
        approvalRequestId: input.approvalId,
        source: "ADMIN",
        requestId: input.approvalId,
      },
    });
  }

  await writeAudit(ctx, tx, {
    actorId: input.checkerUserId,
    role: input.checkerRole,
    action: "MERCHANT_EDIT_APPLIED",
    entityType: "MERCHANT",
    entityId: input.merchantId,
    beforeJson: before,
    afterJson: updated,
    approvalRequestId: input.approvalId,
  });

  return {
    status: "EXECUTED",
    entityId: input.merchantId,
    idempotent: false,
  };
}

/**
 * Applies a pending authority/role change of a user (design §7.1).
 */
export async function executeUserAuthorityChange(
  ctx: GovernanceExecutionContext,
  tx: Tx,
  input: {
    approvalId: string;
    userId: string;
    payload: unknown;
    checkerUserId: string;
    checkerRole: string;
  },
): Promise<GovernanceExecutionResult> {
  const users = modelOf(tx, "user");
  const user = await users.findUnique({ where: { id: input.userId } });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "The user does not exist");
  }
  const payload = asRecord(input.payload);
  const authorities = payload.authoritiesMap ?? payload.authorities_map;
  const role = payload.role;
  const data: Record<string, unknown> = {};
  if (authorities !== undefined) {
    data.authoritiesMap = authorities;
  }
  if (role !== undefined) {
    data.role = role;
  }
  if (Object.keys(data).length === 0) {
    throw new ApiError(
      409,
      "USER_APPROVAL_NO_FIELDS",
      "The approval carries neither an authorities map nor a role change",
    );
  }
  const updated = await users.update({ where: { id: input.userId }, data });
  await writeAudit(ctx, tx, {
    actorId: input.checkerUserId,
    role: input.checkerRole,
    action: "USER_AUTHORITY_UPDATED",
    entityType: "USER",
    entityId: input.userId,
    beforeJson: { role: String(user.role), authoritiesMap: user.authoritiesMap },
    afterJson: { role: String(updated.role), authoritiesMap: updated.authoritiesMap },
    approvalRequestId: input.approvalId,
  });
  return {
    status: "EXECUTED",
    entityId: input.userId,
    idempotent: false,
  };
}

interface GatewayGoLiveEvidenceRecord {
  scenarioResults: { scenario: string; passed: boolean; details?: string }[];
  amountPipelineContractPassed: boolean;
  referenceFormatContractPassed: boolean;
  cryptographicSignatureContractPassed: boolean;
  channels: ChannelVerificationEvidence[];
  rollbackVersionId: string | null;
  routeLimitsPreviewed: boolean;
  commissionProfilePreviewed: boolean;
  statementParserPreviewed: boolean;
  evidenceLevel: "VERIFIED" | "INTERNAL" | "UNVERIFIED" | "PARTIAL" | "HIGH_RISK";
  internalContractSuitePassed: boolean;
  highRiskExecutiveAcceptanceSigned: boolean;
  panFieldCount: number;
  pciScopeReviewPassed: boolean;
  canaryTrafficPlanConfigured: boolean;
  routeAlertsConfigured: boolean;
  runbooksConfigured: boolean;
  contractDetails: Record<string, string[]>;
}

const gatewayGoLiveEvidenceOf = (
  version: { id: string; createdById: string; rollbackVersionId: string | null },
  record: GatewayGoLiveEvidenceRecord,
  checkerUserId: string | null,
) => ({
  makerUserId: version.createdById,
  checkerUserId: checkerUserId ?? "",
  scenarioResults: record.scenarioResults,
  amountPipelineContractPassed: record.amountPipelineContractPassed,
  referenceFormatContractPassed: record.referenceFormatContractPassed,
  cryptographicSignatureContractPassed: record.cryptographicSignatureContractPassed,
  channels: record.channels,
  rollbackVersionId: record.rollbackVersionId ?? version.rollbackVersionId,
  routeLimitsPreviewed: record.routeLimitsPreviewed,
  commissionProfilePreviewed: record.commissionProfilePreviewed,
  statementParserPreviewed: record.statementParserPreviewed,
  evidenceLevel: record.evidenceLevel,
  internalContractSuitePassed: record.internalContractSuitePassed,
  highRiskExecutiveAcceptanceSigned: record.highRiskExecutiveAcceptanceSigned,
  panFieldCount: record.panFieldCount,
  pciScopeReviewPassed: record.pciScopeReviewPassed,
  canaryTrafficPlanConfigured: record.canaryTrafficPlanConfigured,
  routeAlertsConfigured: record.routeAlertsConfigured,
  runbooksConfigured: record.runbooksConfigured,
});

/**
 * The twelve go-live gates of a gateway version, evaluated inside the
 * caller's transaction so the gate decision and the go-live state change
 * commit together (design §14).
 */
export async function assertGatewayVersionGoLive(
  tx: Tx,
  versionId: string,
  checkerUserId: string | null,
): Promise<GoLiveValidationResult> {
  const version = await modelOf(tx, "gatewayVersion").findUnique({ where: { id: versionId } });
  if (!version) {
    throw new ApiError(404, "GATEWAY_VERSION_NOT_FOUND", "The gateway version does not exist");
  }
  const approval = version.approvalRequestId
    ? await modelOf(tx, "approvalRequest").findUnique({ where: { id: String(version.approvalRequestId) } })
    : null;
  const record = await modelOf(tx, "gatewayVersionEvidence").findUnique({
    where: { gatewayVersionId: versionId },
  });
  if (!record) {
    throw new ApiError(
      409,
      "GO_LIVE_EVIDENCE_MISSING",
      "The go-live evidence of the gateway version was never collected",
      { failedGateIds: ["SANDBOX_SCENARIO_SUITE"] },
    );
  }
  const evidence = record.evidenceJson as unknown as GatewayGoLiveEvidenceRecord;
  const gates = new GoLiveGateValidator();
  const result = await gates.validate(
    gatewayGoLiveEvidenceOf(
      version as { id: string; createdById: string; rollbackVersionId: string | null },
      evidence,
      checkerUserId ?? approval?.checkerUserId ?? null,
    ),
  );
  if (!result.passed) {
    throw new ApiError(
      409,
      "GO_LIVE_GATES_FAILED",
      `The gateway version does not pass the go-live gates: ${result.failedGateIds.join(", ")}`,
      { failedGateIds: result.failedGateIds, gates: result.gates },
    );
  }
  return result;
}

/**
 * Promotes a gateway version to LIVE after the gates pass, using the caller's
 * transaction. The previous live version is superseded in the same write.
 */
export async function activateGatewayVersionInTransaction(
  tx: Tx,
  versionId: string,
  checkerUserId: string | null,
): Promise<{ versionId: string; gatewayId: string }> {
  const version = await modelOf(tx, "gatewayVersion").findUnique({ where: { id: versionId } });
  if (!version) {
    throw new ApiError(404, "GATEWAY_VERSION_NOT_FOUND", "The gateway version does not exist");
  }
  await assertGatewayVersionGoLive(tx, versionId, checkerUserId);
  await modelOf(tx, "gatewayVersion").updateMany({
    where: { gatewayId: String(version.gatewayId), state: "LIVE", id: { not: String(version.id) } },
    data: { state: "SUPERSEDED" },
  });
  await modelOf(tx, "gatewayVersion").update({
    where: { id: String(version.id) },
    data: { state: "LIVE" },
  });
  await modelOf(tx, "gateway").update({
    where: { id: String(version.gatewayId) },
    data: { activeVersionId: String(version.id), status: "LIVE" },
  });
  return { versionId: String(version.id), gatewayId: String(version.gatewayId) };
}

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

const linkCountOf = (row: any, camel: string, snake: string, fallback = 0): number => {
  const value = row?.[camel] ?? row?.[snake];
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Commits the link slot of a released AML hold.
 *
 * The attempt transition that guards this call is conditional on
 * `terminal_at IS NULL`, so the slot is consumed exactly once even when a
 * re-run or a concurrent sweeper resolves the same case. An infinite-use
 * link never becomes `COMPLETED`; only a finite link whose last slot is
 * consumed does.
 */
const commitAmlLinkSlot = async (tx: Tx, linkId: string): Promise<void> => {
  const client = tx as Record<string, any>;
  if (typeof client.$executeRawUnsafe === "function") {
    await client.$executeRawUnsafe(
      `UPDATE payment_links
          SET state = CASE
                WHEN infinite_use = 0 AND confirmed_count + 1 >= use_count THEN 'COMPLETED'
                ELSE state
              END,
              confirmed_count = confirmed_count + 1,
              active_locked_count = GREATEST(0, active_locked_count - 1),
              updated_at = NOW()
        WHERE id = ?`,
      linkId,
    );
    return;
  }
  const links = modelOf(tx, "paymentLink");
  const link = await links.findUnique({ where: { id: linkId } });
  if (!link) {
    return;
  }
  const infinite = Boolean(link.infiniteUse ?? link.infinite_use);
  const confirmed = linkCountOf(link, "confirmedCount", "confirmed_count");
  const active = linkCountOf(link, "activeLockedCount", "active_locked_count");
  const useCount = linkCountOf(link, "useCount", "use_count", 1);
  const complete = !infinite && confirmed + 1 >= useCount;
  await links.update({
    where: { id: linkId },
    data: {
      confirmedCount: confirmed + 1,
      activeLockedCount: Math.max(0, active - 1),
      ...(complete ? { state: "COMPLETED" } : {}),
    },
  });
};

/**
 * Releases the link slot of a voided AML hold. The confirmed count is never
 * advanced, so a void does not consume capacity.
 */
const releaseAmlLinkSlot = async (tx: Tx, linkId: string): Promise<void> => {
  const client = tx as Record<string, any>;
  if (typeof client.$executeRawUnsafe === "function") {
    await client.$executeRawUnsafe(
      `UPDATE payment_links
          SET active_locked_count = GREATEST(0, active_locked_count - 1),
              updated_at = NOW()
        WHERE id = ?`,
      linkId,
    );
    return;
  }
  const links = modelOf(tx, "paymentLink");
  const link = await links.findUnique({ where: { id: linkId } });
  if (!link) {
    return;
  }
  const active = linkCountOf(link, "activeLockedCount", "active_locked_count");
  await links.update({
    where: { id: linkId },
    data: { activeLockedCount: Math.max(0, active - 1) },
  });
};

/**
 * Finalises the payment attempt of an AML case.
 *
 * The conditional `terminal_at IS NULL` update is the single-writer guard:
 * only the caller that changes a non-terminal attempt goes on to move the
 * link slot, so neither a re-run nor a concurrent sweeper can double count.
 */
const finalizeAmlAttempt = async (
  ctx: GovernanceExecutionContext,
  tx: Tx,
  attempt: any,
  input: {
    status: "SUCCEEDED" | "FAILED";
    ledgerEntryId: string | null;
    action: AmlCaseAction;
  },
): Promise<boolean> => {
  if (!attempt) {
    return false;
  }
  const updated = await modelOf(tx, "paymentAttempt").updateMany({
    where: { id: String(attempt.id), terminalAt: null },
    data: {
      status: input.status,
      terminalAt: new Date(),
      nextCheckAt: null,
      ...(input.ledgerEntryId ? { ledgerEntryId: input.ledgerEntryId } : {}),
    },
  });
  const affected = Number(updated?.count ?? 0);
  if (affected === 0) {
    return false;
  }
  const linkId = attempt.linkId ? String(attempt.linkId) : null;
  if (linkId) {
    if (input.status === "SUCCEEDED") {
      await commitAmlLinkSlot(tx, linkId);
    } else {
      await releaseAmlLinkSlot(tx, linkId);
    }
  }
  if (ctx.transitionBus) {
    await ctx.transitionBus.publish(ATTEMPT_TRANSITION_TOPIC, {
      attemptId: String(attempt.id),
      status: input.status,
      substatus: input.action === "RELEASE" ? "AML_RELEASED" : "AML_VOID",
    });
  }
  return true;
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

  // The case resolution owns the attempt: a release settles it and commits
  // the reserved link slot, a rejection voids it and gives the slot back.
  // Both transitions run in this same transaction as the posting.
  const attemptFinalized = attempt && (action === "RELEASE" || action === "REJECT")
    ? await finalizeAmlAttempt(ctx, tx, attempt, {
      status: action === "RELEASE" ? "SUCCEEDED" : "FAILED",
      ledgerEntryId: action === "RELEASE" ? journalEntryId : null,
      action,
    })
    : false;

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
      attemptFinalized,
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
  adjustmentId: string | null;
  approvalRequestId: string | null;
  escrowed: boolean;
  journalEntryId: string | null;
  status?: "DRAFTED" | "NO_CHARGEBACK_DRAFTED";
  reason?: string;
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

  const lockedAttempt = (await lockAttemptForGovernance(ctx, tx, input.attemptId)) ?? attempt;
  const chargedAmount = toDecimal(lockedAttempt.totalChargedAmount);
  const alreadyRefunded = await sumGovernanceRefunds(ctx, tx, input.attemptId, ["EXECUTED", "EXECUTING"]);
  const unrefundedAmount = Decimal.max(chargedAmount.minus(alreadyRefunded), new Decimal(0));
  const requestedAmount = toDecimal(input.amount);
  const chargebackAmount = Decimal.min(requestedAmount, unrefundedAmount);

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

  if (!chargebackAmount.gt(0)) {
    const reason = unrefundedAmount.lte(0) ? "ATTEMPT_FULLY_REFUNDED" : "NO_CHARGEBACK_AMOUNT";
    await writeAudit(ctx, tx, {
      actorId: input.actorUserId,
      role: input.actorRole,
      action: "DISPUTE_OPENED",
      entityType: "DISPUTE",
      entityId: String(dispute.id),
      afterJson: {
        amount: input.amount.toFixed(4),
        chargedAmount: chargedAmount.toFixed(4),
        alreadyRefunded: alreadyRefunded.toFixed(4),
        unrefundedAmount: unrefundedAmount.toFixed(4),
        currency,
        externalDisputeRef: input.externalDisputeRef,
        escrowed: false,
        journalEntryId: null,
        chargebackDrafted: false,
        reason,
      },
    });
    return {
      disputeId: String(dispute.id),
      adjustmentId: null,
      approvalRequestId: null,
      escrowed: false,
      journalEntryId: null,
      status: "NO_CHARGEBACK_DRAFTED",
      reason,
    };
  }

  const targetGlAccountId = await resolveMerchantWalletGlAccountId(tx, merchantId, input.attemptId);
  const adjustment = await modelOf(tx, "adjustment").create({
    data: {
      type: "CHARGEBACK",
      targetGlAccountId,
      sourceAttemptId: input.attemptId,
      disputeId: String(dispute.id),
      draftedBySystem: true,
      amount: chargebackAmount,
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
  const settlementTarget = String(lockedAttempt.settlementTarget ?? "PLATFORM_CLEARING");
  if (settlementTarget !== "MERCHANT_DIRECT") {
    const commission = Decimal.min(toDecimal(lockedAttempt.platformCommissionAmount), chargebackAmount);
    const merchantAmount = chargebackAmount.minus(commission);
    if (merchantAmount.lt(0)) {
      throw new ApiError(409, "CHARGEBACK_AMOUNT_INCONSISTENT", "The platform commission exceeds the disputed amount");
    }
    const journal = buildLedgerTemplate("CHARGEBACK_RESERVE_AND_LOST", {
      amount: chargebackAmount,
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
      amount: chargebackAmount.toFixed(4),
      requestedAmount: requestedAmount.toFixed(4),
      chargedAmount: chargedAmount.toFixed(4),
      alreadyRefunded: alreadyRefunded.toFixed(4),
      unrefundedAmount: unrefundedAmount.toFixed(4),
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
      amount: chargebackAmount.toFixed(4),
    },
    approvalRequestId: String(approval.id),
  });

  return {
    disputeId: String(dispute.id),
    adjustmentId: String(adjustment.id),
    approvalRequestId: String(approval.id),
    escrowed,
    journalEntryId,
    status: "DRAFTED",
  };
}

/**
 * A refund runs in three short transactions.
 *
 * The gateway is an external call: holding the attempt row lock while it is
 * in flight makes the gateway's own attempt update (on a different database
 * connection) block until the approval transaction times out. Phase 1 claims
 * the adjustment and releases every lock, phase 2 talks to the gateway with
 * no transaction open, and phase 3 books the confirmed refund.
 */
interface TransactionCapableRepositories {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

const runIsolatedTransaction = async <T>(
  ctx: GovernanceExecutionContext,
  fallbackTx: Tx,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> => {
  const repositories = ctx.repositories as unknown as Partial<TransactionCapableRepositories>;
  if (typeof repositories.transaction === "function") {
    return repositories.transaction(fn);
  }
  const candidate = fallbackTx as unknown as { $transaction?: (callback: (tx: Tx) => Promise<T>) => Promise<T> };
  if (typeof candidate.$transaction === "function") {
    return candidate.$transaction(fn);
  }
  return fn(fallbackTx);
};

const refundSkippedResult = (adjustment: any, reason: string): GovernanceExecutionResult => ({
  status: "SKIPPED",
  reason,
  entityId: String(adjustment.id),
  journalEntryId: adjustment.journalEntryId ?? null,
  idempotent: true,
});

const refundInFlightResult = (adjustment: any): GovernanceExecutionResult => ({
  status: "HELD",
  reason: "REFUND_IN_FLIGHT",
  entityId: String(adjustment.id),
  idempotent: true,
});

/**
 * Phase 1 of an approved refund: verify every guard, lock the attempt and
 * move the adjustment to `EXECUTING`, then COMMIT. No lock survives this
 * function, so the gateway call in phase 2 never contends with it.
 */
const claimRefundAdjustment = async (
  ctx: GovernanceExecutionContext,
  fallbackTx: Tx,
  input: { adjustmentId: string; checkerUserId: string; checkerRole: string; approvalRequestId?: string | null },
  initial?: { sourceAttemptId?: unknown } | null,
): Promise<
  | { kind: "skipped"; result: GovernanceExecutionResult }
  | { kind: "in_flight"; result: GovernanceExecutionResult }
  | {
      kind: "claimed";
      adjustment: any;
      sourceAttempt: any;
      amount: Decimal;
      merchantId: string;
    }
> => {
  return runIsolatedTransaction(ctx, fallbackTx, async (tx) => {
    // The attempt lock is deliberately the FIRST statement of the claim
    // transaction. If a concurrent refund already holds it, we wait before
    // taking the read snapshot, so the refund cap below sees every committed
    // EXECUTING / EXECUTED sibling.
    const initialAttemptId = initial?.sourceAttemptId ? String(initial.sourceAttemptId) : null;
    let lockedAttempt = initialAttemptId
      ? await lockAttemptForGovernance(ctx, tx, initialAttemptId)
      : null;
    const adjustments = modelOf(tx, "adjustment");
    const adjustment = await adjustments.findUnique({ where: { id: input.adjustmentId } });
    if (!adjustment) {
      throw new ApiError(404, "ADJUSTMENT_NOT_FOUND", "The adjustment does not exist");
    }
    if (String(adjustment.type) !== "REFUND") {
      throw new ApiError(409, "ADJUSTMENT_NOT_REFUND", "The adjustment is not a refund");
    }
    if (adjustment.state === "EXECUTED") {
      return { kind: "skipped" as const, result: refundSkippedResult(adjustment, "ADJUSTMENT_ALREADY_EXECUTED") };
    }
    if (adjustment.state === "REJECTED") {
      return { kind: "skipped" as const, result: refundSkippedResult(adjustment, "ADJUSTMENT_REJECTED") };
    }
    if (adjustment.state === "EXECUTING") {
      return { kind: "in_flight" as const, result: refundInFlightResult(adjustment) };
    }
    const amount = toDecimal(adjustment.amount);
    if (!amount.gt(0)) {
      throw new ApiError(400, "INVALID_LEDGER_AMOUNT", "The adjustment amount must be greater than zero");
    }
    if (!adjustment.sourceAttemptId) {
      throw new ApiError(
        409,
        "REFUND_ATTEMPT_REQUIRED",
        "A refund adjustment must point at the payment attempt that is refunded",
      );
    }
    if (!ctx.engine) {
      throw new ApiError(
        503,
        "REFUND_ENGINE_UNAVAILABLE",
        "The universal rail engine is not available to execute the gateway refund",
      );
    }
    // Locking the attempt serialises concurrent refunds of the same payment.
    // The lock is released by the commit at the end of this transaction, long
    // before the gateway is called.
    if (!lockedAttempt) {
      lockedAttempt = await lockAttemptForGovernance(ctx, tx, String(adjustment.sourceAttemptId));
    }
    if (!lockedAttempt) {
      throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The refunded payment attempt does not exist");
    }
    const refundableAmount = lockedAttempt.settledAmount !== null && lockedAttempt.settledAmount !== undefined
      ? toDecimal(lockedAttempt.settledAmount)
      : toDecimal(lockedAttempt.totalChargedAmount);
    await assertRefundAllowedByRail(tx, lockedAttempt, amount, refundableAmount);
    const priorRefunds = await sumGovernanceRefunds(ctx, tx, String(lockedAttempt.id), ["EXECUTED", "EXECUTING"]);
    const remainingRefundable = refundableAmount.minus(priorRefunds);
    if (priorRefunds.plus(amount).gt(refundableAmount)) {
      throw new ApiError(
        409,
        "REFUND_EXCEEDS_SETTLED_AMOUNT",
        `The refund of ${amount.toFixed(4)} exceeds the unrefunded settled amount of ${Decimal.max(remainingRefundable, new Decimal(0)).toFixed(4)}`,
        {
          attemptId: String(lockedAttempt.id),
          refundableAmount: refundableAmount.toFixed(4),
          alreadyRefunded: priorRefunds.toFixed(4),
          requestedAmount: amount.toFixed(4),
        },
      );
    }
    // A conditional claim makes a concurrent execution a no-op instead of a
    // second gateway call: only the transaction that still sees the
    // pre-execution state wins.
    const claimed = await adjustments.updateMany({
      where: { id: String(adjustment.id), state: { in: ["DRAFT", "PENDING_REVIEW", "APPROVED"] } },
      data: { state: "EXECUTING" },
    });
    if (!claimed || Number(claimed.count ?? 0) === 0) {
      const current = await adjustments.findUnique({ where: { id: String(adjustment.id) } });
      if (!current) {
        throw new ApiError(404, "ADJUSTMENT_NOT_FOUND", "The adjustment does not exist");
      }
      if (current.state === "EXECUTED") {
        return { kind: "skipped" as const, result: refundSkippedResult(current, "ADJUSTMENT_ALREADY_EXECUTED") };
      }
      if (current.state === "REJECTED") {
        return { kind: "skipped" as const, result: refundSkippedResult(current, "ADJUSTMENT_REJECTED") };
      }
      return { kind: "in_flight" as const, result: refundInFlightResult(current) };
    }
    const merchantId = await resolveAdjustmentMerchantId(tx, adjustment);
    return { kind: "claimed" as const, adjustment, sourceAttempt: lockedAttempt, amount, merchantId };
  });
};

/**
 * Phase 3 of an approved refund: re-read the attempt and the adjustment,
 * post `FULL_REFUND` / `INTERNAL_REFUND` (the poster dedupes on
 * `(refType, refId)`), mark the adjustment `EXECUTED` and write the audit row
 * in one transaction.
 */
const finalizeRefundAdjustment = async (
  ctx: GovernanceExecutionContext,
  fallbackTx: Tx,
  input: {
    adjustmentId: string;
    checkerUserId: string;
    checkerRole: string;
    approvalRequestId?: string | null;
  },
  gatewayResult: { status: string; attempt?: { ownershipMode?: string | null } | null },
): Promise<GovernanceExecutionResult> => {
  return runIsolatedTransaction(ctx, fallbackTx, async (tx) => {
    const adjustments = modelOf(tx, "adjustment");
    const adjustment = await adjustments.findUnique({ where: { id: input.adjustmentId } });
    if (!adjustment) {
      throw new ApiError(404, "ADJUSTMENT_NOT_FOUND", "The adjustment does not exist");
    }
    if (adjustment.state === "EXECUTED") {
      return refundSkippedResult(adjustment, "ADJUSTMENT_ALREADY_EXECUTED");
    }
    if (adjustment.state === "REJECTED") {
      return refundSkippedResult(adjustment, "ADJUSTMENT_REJECTED");
    }
    const amount = toDecimal(adjustment.amount);
    const sourceAttempt = adjustment.sourceAttemptId
      ? await modelOf(tx, "paymentAttempt").findUnique({ where: { id: String(adjustment.sourceAttemptId) } })
      : null;
    const merchantId = await resolveAdjustmentMerchantId(tx, adjustment);
    const reverseCommission = adjustment.reverseCommission === true;
    const commission = reverseCommission
      ? Decimal.min(toDecimal(sourceAttempt?.platformCommissionAmount), amount)
      : new Decimal(0);
    const merchantAmount = amount.minus(commission);
    if (merchantAmount.lt(0)) {
      throw new ApiError(409, "ADJUSTMENT_AMOUNT_INCONSISTENT", "The platform commission exceeds the adjustment amount");
    }
    const targetAccount = await modelOf(tx, "glAccount").findUnique({
      where: { id: String(adjustment.targetGlAccountId) },
    });
    const accounts = targetAccount?.accountType === "MERCHANT_WALLET"
      ? { MERCHANT_WALLET: String(adjustment.targetGlAccountId) }
      : undefined;

    let ownershipMode = gatewayResult.attempt?.ownershipMode ?? null;
    if (!ownershipMode) {
      const gatewayVersion = sourceAttempt?.gatewayVersionId
        ? await modelOf(tx, "gatewayVersion").findUnique({ where: { id: String(sourceAttempt.gatewayVersionId) } })
        : null;
      const gateway = gatewayVersion
        ? await modelOf(tx, "gateway").findUnique({ where: { id: String(gatewayVersion.gatewayId) } })
        : null;
      ownershipMode = gateway?.kind === "INTERNAL"
        ? "INTERNAL"
        : sourceAttempt?.settlementTarget === "MERCHANT_DIRECT"
          ? "MERCHANT_DIRECT"
          : "PLATFORM_CLEARING";
    }
    const templateName = ownershipMode === "INTERNAL" ? "INTERNAL_REFUND" : "FULL_REFUND";
    const journal = buildLedgerTemplate(templateName, {
      amount,
      commissionAmount: commission,
      merchantAmount,
    });
    // Keyed by the adjustment, so even a race between two finalisers can only
    // ever create one journal entry.
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
    await writeAudit(ctx, tx, {
      actorId: input.checkerUserId,
      role: input.checkerRole,
      action: "ADJUSTMENT_EXECUTED",
      entityType: "ADJUSTMENT",
      entityId: String(adjustment.id),
      beforeJson: { state: "EXECUTING", type: "REFUND" },
      afterJson: {
        state: "EXECUTED",
        type: "REFUND",
        template: templateName,
        journalEntryId: posted.entry.id,
        amount: amount.toFixed(4),
        outcome: null,
      },
      approvalRequestId: input.approvalRequestId ?? null,
    });
    return {
      status: "EXECUTED" as const,
      entityId: String(adjustment.id),
      template: templateName,
      journalEntryId: posted.entry.id,
      idempotent: posted.idempotent,
    };
  });
};

/**
 * Executes an approved refund in claim -> gateway -> finalize phases.
 */
const executeRefundAdjustment = async (
  ctx: GovernanceExecutionContext,
  fallbackTx: Tx,
  input: { adjustmentId: string; checkerUserId: string; checkerRole: string; approvalRequestId?: string | null },
  initial?: { sourceAttemptId?: unknown } | null,
): Promise<GovernanceExecutionResult> => {
  const claim = await claimRefundAdjustment(ctx, fallbackTx, input, initial);
  if (claim.kind === "skipped" || claim.kind === "in_flight") {
    return claim.result;
  }
  const sourceAttemptId = String(claim.sourceAttempt.id);
  const gatewayResult = await ctx.engine!.refund(claim.sourceAttempt, claim.amount, String(claim.adjustment.id));
  const gatewayStatus = String(gatewayResult.status ?? "").toUpperCase();
  if (gatewayStatus === "UNKNOWN" || gatewayStatus === "FAILED") {
    // The gateway may or may not have moved the money. Keep the adjustment
    // EXECUTING and schedule reconciliation; never book a refund the gateway
    // did not confirm.
    await runIsolatedTransaction(ctx, fallbackTx, async (tx) => {
      const current = await modelOf(tx, "adjustment").findUnique({ where: { id: input.adjustmentId } });
      if (!current || current.state !== "EXECUTING") {
        return;
      }
      if (!ctx.reconciliationScheduler) {
        await modelOf(tx, "paymentAttempt").update({
          where: { id: sourceAttemptId },
          data: { nextCheckAt: new Date(Date.now() + 60_000) },
        });
      }
      await writeAudit(ctx, tx, {
        actorId: input.checkerUserId,
        role: input.checkerRole,
        action: "ADJUSTMENT_REFUND_PENDING_RECONCILIATION",
        entityType: "ADJUSTMENT",
        entityId: String(current.id),
        afterJson: {
          state: "EXECUTING",
          gatewayStatus,
          attemptId: sourceAttemptId,
          amount: claim.amount.toFixed(4),
        },
        approvalRequestId: input.approvalRequestId ?? null,
      });
    });
    if (ctx.reconciliationScheduler) {
      await ctx.reconciliationScheduler.schedule(sourceAttemptId, String(claim.adjustment.id));
    }
    return {
      status: "HELD",
      reason: gatewayStatus === "FAILED" ? "REFUND_GATEWAY_FAILED" : "REFUND_GATEWAY_UNKNOWN",
      entityId: String(claim.adjustment.id),
    };
  }
  return finalizeRefundAdjustment(ctx, fallbackTx, input, gatewayResult);
};

/**
 * Executes an adjustment and posts the matching journal entry.
 *
 * A `CHARGEBACK` posts the reserve outcome (`CHARGEBACK_WON` or
 * `CHARGEBACK_RESERVE_AND_LOST`, stage `LOST`), a fee correction posts
 * `FEE_VARIANCE_TRUE_UP` and a manual debit or credit posts the matching
 * wallet movement. The posting and the state change share one transaction.
 * A `REFUND` instead runs in the three short phases above so that no
 * transaction is ever held across the gateway call (design §8.2).
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
  if (type === "REFUND") {
    return executeRefundAdjustment(ctx, tx, input, adjustment);
  }
  const amount = toDecimal(adjustment.amount);
  if (!amount.gt(0)) {
    throw new ApiError(400, "INVALID_LEDGER_AMOUNT", "The adjustment amount must be greater than zero");
  }
  const merchantId = await resolveAdjustmentMerchantId(tx, adjustment);
  const sourceAttempt = adjustment.sourceAttemptId
    ? await modelOf(tx, "paymentAttempt").findUnique({ where: { id: String(adjustment.sourceAttemptId) } })
    : null;
  const reverseCommission = adjustment.reverseCommission === true;
  const commission = reverseCommission
    ? Decimal.min(toDecimal(sourceAttempt?.platformCommissionAmount), amount)
    : new Decimal(0);
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

    if (disputeOutcome === "WON") {
      journal = buildLedgerTemplate("CHARGEBACK_WON", {
        amount,
        commissionAmount: commission,
        merchantAmount,
      });
      templateName = "CHARGEBACK_WON";
    } else if (projected.lt(0)) {
      // The wallet goes negative but stays inside the merchant's recovery
      // net: book the chargeback against the insufficient wallet (design
      // §11.3 entry 15) instead of holding it.
      journal = buildLedgerTemplate("CHARGEBACK_INSUFFICIENT", {
        amount,
        commissionAmount: commission,
        merchantAmount,
      });
      templateName = "CHARGEBACK_INSUFFICIENT";
    } else {
      journal = buildLedgerTemplate("CHARGEBACK_RESERVE_AND_LOST", {
        amount,
        commissionAmount: commission,
        merchantAmount,
        stage: "LOST",
      });
      templateName = "CHARGEBACK_RESERVE_AND_LOST";
    }
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

const executeRegulatoryReportApproval = async (
  ctx: GovernanceExecutionContext,
  tx: Tx,
  input: { approvalId: string; reportId: string; checkerUserId: string; checkerRole: string },
): Promise<GovernanceExecutionResult> => {
  const reports = modelOf(tx, "regulatoryReport");
  const report = await reports.findUnique({ where: { id: input.reportId } });
  if (!report) {
    throw new ApiError(404, "REGULATORY_REPORT_NOT_FOUND", "The regulatory report does not exist");
  }
  if (report.status === "APPROVED") {
    return {
      status: "SKIPPED",
      reason: "REGULATORY_REPORT_ALREADY_APPROVED",
      entityId: String(report.id),
      idempotent: true,
    };
  }
  if (report.status !== "PENDING_CHECKER" && report.status !== "DRAFT") {
    throw new ApiError(
      409,
      "REGULATORY_REPORT_NOT_PENDING_CHECKER",
      `The regulatory report is '${report.status}' and cannot be approved`,
      { reportId: String(report.id), status: String(report.status) },
    );
  }
  const updated = await reports.update({
    where: { id: String(report.id) },
    data: { status: "APPROVED", approvalRequestId: input.approvalId },
  });
  await writeAudit(ctx, tx, {
    actorId: input.checkerUserId,
    role: input.checkerRole,
    action: "REGULATORY_REPORT_APPROVED",
    entityType: "REGULATORY_REPORT",
    entityId: String(report.id),
    beforeJson: { status: String(report.status) },
    afterJson: { status: "APPROVED", reportType: updated.reportType, authority: updated.authority },
    approvalRequestId: input.approvalId,
  });
  return {
    status: "EXECUTED",
    entityId: String(report.id),
    idempotent: false,
  };
};

const executeReportingRuleApproval = async (
  ctx: GovernanceExecutionContext,
  tx: Tx,
  input: { approvalId: string; ruleId: string; checkerUserId: string; checkerRole: string },
): Promise<GovernanceExecutionResult> => {
  const rules = modelOf(tx, "reportingRule");
  const rule = await rules.findUnique({ where: { id: input.ruleId } });
  if (!rule) {
    throw new ApiError(404, "REPORTING_RULE_NOT_FOUND", "The reporting rule does not exist");
  }
  if (rule.status === "CONFIRMED") {
    return {
      status: "SKIPPED",
      reason: "REPORTING_RULE_ALREADY_CONFIRMED",
      entityId: String(rule.id),
      idempotent: true,
    };
  }
  if (rule.status !== "PROVISIONAL") {
    throw new ApiError(
      409,
      "REPORTING_RULE_NOT_PROMOTABLE",
      `The reporting rule is '${rule.status}' and cannot be promoted`,
      { ruleId: String(rule.id), status: String(rule.status) },
    );
  }
  const updated = await rules.update({
    where: { id: String(rule.id) },
    data: { status: "CONFIRMED", approvalRequestId: input.approvalId },
  });
  await writeAudit(ctx, tx, {
    actorId: input.checkerUserId,
    role: input.checkerRole,
    action: "REPORTING_RULE_CONFIRMED",
    entityType: "REPORTING_RULE",
    entityId: String(rule.id),
    beforeJson: { status: "PROVISIONAL" },
    afterJson: { status: "CONFIRMED", reportType: updated.reportType, authority: updated.authority },
    approvalRequestId: input.approvalId,
  });
  return {
    status: "EXECUTED",
    entityId: String(rule.id),
    idempotent: false,
  };
};

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
  if (subjectType === "REGULATORY_REPORT") {
    return executeRegulatoryReportApproval(ctx, tx, {
      approvalId: input.approval.id,
      reportId: input.approval.subjectId,
      checkerUserId: input.checkerUserId,
      checkerRole: input.checkerRole,
    });
  }
  if (subjectType === "REPORTING_RULE") {
    return executeReportingRuleApproval(ctx, tx, {
      approvalId: input.approval.id,
      ruleId: input.approval.subjectId,
      checkerUserId: input.checkerUserId,
      checkerRole: input.checkerRole,
    });
  }
  if (subjectType === "JOIN_REQUEST") {
    const payload = asRecord(input.approval.payloadDiffJson);
    const decision = String(payload.decision ?? "APPROVED").toUpperCase();
    if (decision !== "APPROVED") {
      throw new ApiError(
        409,
        "JOIN_REQUEST_NOT_APPROVABLE",
        `The join request approval carries a '${decision}' decision, so it cannot activate the merchant`,
      );
    }
    const activated = await activateApprovedJoinRequest(ctx, tx, {
      joinRequestId: input.approval.subjectId,
      checkerUserId: input.checkerUserId,
      checkerRole: input.checkerRole,
      approvalRequestId: input.approval.id,
      decisionReasonCode: payload.reasonCode === undefined ? null : String(payload.reasonCode),
      decisionNotes: payload.notes === undefined ? null : String(payload.notes),
      proposedRiskTier: payload.proposedRiskTier === undefined ? null : String(payload.proposedRiskTier),
    });
    return {
      status: "EXECUTED",
      entityId: activated.joinRequestId,
      idempotent: false,
    };
  }
  if (subjectType === "MERCHANT") {
    return executeMerchantPatch(ctx, tx, {
      approvalId: input.approval.id,
      merchantId: input.approval.subjectId,
      patch: input.approval.payloadDiffJson,
      checkerUserId: input.checkerUserId,
      checkerRole: input.checkerRole,
    });
  }
  if (subjectType === "USER") {
    return executeUserAuthorityChange(ctx, tx, {
      approvalId: input.approval.id,
      userId: input.approval.subjectId,
      payload: input.approval.payloadDiffJson,
      checkerUserId: input.checkerUserId,
      checkerRole: input.checkerRole,
    });
  }
  if (subjectType === "GATEWAY_VERSION") {
    const activated = await activateGatewayVersionInTransaction(
      tx,
      input.approval.subjectId,
      input.checkerUserId,
    );
    await writeAudit(ctx, tx, {
      actorId: input.checkerUserId,
      role: input.checkerRole,
      action: "GATEWAY_VERSION_ACTIVATED",
      entityType: "GATEWAY_VERSION",
      entityId: activated.versionId,
      beforeJson: {},
      afterJson: { state: "LIVE", gatewayId: activated.gatewayId },
      approvalRequestId: input.approval.id,
    });
    return {
      status: "EXECUTED",
      entityId: activated.versionId,
      template: "GATEWAY_VERSION_LIVE",
    };
  }
  throw new ApiError(
    409,
    "NO_EXECUTABLE_SUBJECT",
    `The approval subject type '${subjectType}' has no executable handler`,
    { subjectType, subjectId: input.approval.subjectId },
  );
}
