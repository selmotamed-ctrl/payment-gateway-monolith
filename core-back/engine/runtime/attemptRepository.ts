import { decimal } from "../ledger/LedgerPoster";
import type { AttemptRepository, DynamicAttempt, DynamicAttemptPatch } from "../flow/DynamicRailEngine";
import type { PrismaLike } from "../db/ports";
import { enqueueOutboxEvent } from "../../lib/storageEngine/outbox";

export interface AttemptRow {
  id: string;
  reference: string;
  gatewayReference: string | null;
  status: string;
  substatus: string | null;
  env: string;
  mode: string;
  subMode: string | null;
  currency: string;
  requestedAmount: unknown;
  surchargeAmount: unknown;
  totalChargedAmount: unknown;
  settledAmount: unknown;
  gatewayFeeAmount: unknown;
  providerReference: string | null;
  networkReference: string | null;
  otpAttempts: number;
  maxOtpAttempts?: number;
  pointOfNoReturn?: boolean;
  expiresAt: Date | null;
  contextCiphertext: string;
  customerFieldsMasked: unknown;
  publicOutputs?: unknown;
  ledgerEntryId?: string | null;
  merchantId?: string;
  applicationId?: string;
  railId?: string;
  routeId?: string;
  gatewayVersionId?: string;
  credentialSetId?: string;
  commissionProfileId?: string;
  feeBearer?: string;
  gatewayId?: string;
  settlementTarget?: string;
  platformCommissionAmount?: unknown;
  netMerchantAmount?: unknown;
  gatewayVersion?: {
    setting?: { maxOtpAttempts: number } | null;
    gateway?: { id?: string; kind?: string } | null;
  } | null;
  route?: { mismatchPolicy?: unknown; costModel?: unknown } | null;
}

/**
 * Ledger Rule INTERNAL-1: a first-party (INTERNAL) gateway never books a
 * `GATEWAY_CLEARING` leg. The ownership mode is derived from the pinned
 * settlement target and the gateway kind.
 */
const ownershipModeOf = (row: AttemptRow): DynamicAttempt["ownershipMode"] => {
  if (row.gatewayVersion?.gateway?.kind === "INTERNAL") {
    return "INTERNAL";
  }
  if (row.settlementTarget === "MERCHANT_DIRECT") {
    return "MERCHANT_DIRECT";
  }
  return "PLATFORM_CLEARING";
};

/**
 * The route tolerance is configured per route (`mismatch_policy.tolerance_amount`).
 */
const toleranceOf = (row: AttemptRow): string | undefined => {
  const policy = row.route?.mismatchPolicy;
  if (!policy || typeof policy !== "object") {
    return undefined;
  }
  const value = (policy as Record<string, unknown>).tolerance_amount
    ?? (policy as Record<string, unknown>).toleranceAmount;
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return decimal(value as never).toFixed(4);
  } catch {
    return undefined;
  }
};

/**
 * Whether the route accrues the gateway fee until the T+N settlement instead of
 * deducting it at source. The flag is pinned with the route.
 */
const feeAccrualOf = (row: AttemptRow): boolean => {
  const model = row.route?.costModel;
  if (!model || typeof model !== "object") {
    return false;
  }
  const value = (model as Record<string, unknown>).accrue_fee_at_confirm
    ?? (model as Record<string, unknown>).accrueFeeAtConfirm;
  return value === true || value === "true" || value === 1;
};

const toAttempt = (row: AttemptRow): DynamicAttempt => {
  const masked = (row.customerFieldsMasked ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    reference: row.reference,
    gatewayReference: row.gatewayReference ?? undefined,
    status: row.status as DynamicAttempt["status"],
    substatus: row.substatus ?? undefined,    env: row.env,
    mode: row.mode,
    subMode: row.subMode ?? undefined,
    currency: row.currency,
    requestedAmount: decimal(row.requestedAmount as never).toFixed(4),
    surchargeAmount: decimal(row.surchargeAmount as never).toFixed(4),
    totalChargedAmount: decimal(row.totalChargedAmount as never).toFixed(4),
    settledAmount: row.settledAmount === null || row.settledAmount === undefined
      ? undefined
      : decimal(row.settledAmount as never).toFixed(4),
    gatewayFeeAmount: row.gatewayFeeAmount === null || row.gatewayFeeAmount === undefined
      ? undefined
      : decimal(row.gatewayFeeAmount as never).toFixed(4),
    providerReference: row.providerReference ?? undefined,
    networkReference: row.networkReference ?? undefined,
    otpAttempts: row.otpAttempts,
    maxOtpAttempts: row.maxOtpAttempts ?? row.gatewayVersion?.setting?.maxOtpAttempts ?? 3,
    pointOfNoReturn: row.pointOfNoReturn ?? false,
    expiresAt: row.expiresAt ?? undefined,
    context: masked,
    contextCiphertext: row.contextCiphertext,
    publicOutputs: (row.publicOutputs as Record<string, unknown> | undefined) ?? {},
    ledgerEntryId: row.ledgerEntryId ?? undefined,
    merchantId: row.merchantId,
    applicationId: row.applicationId,
    railId: row.railId,
    routeId: row.routeId,
    gatewayVersionId: row.gatewayVersionId,
    // `payment_attempts` has no `gateway_id` column: the gateway of an
    // attempt is the gateway of the version the attempt pins (design v5 §9.1
    // rule 1). The outbound consumer is resolved from it, so the projection
    // has to carry it.
    gatewayId: row.gatewayVersion?.gateway?.id ?? row.gatewayId,
    credentialSetId: row.credentialSetId,
    commissionProfileId: row.commissionProfileId,
    feeBearer: row.feeBearer as DynamicAttempt["feeBearer"],
    platformCommissionAmount: row.platformCommissionAmount === undefined
      ? undefined
      : decimal(row.platformCommissionAmount as never).toFixed(4),
    netMerchantAmount: row.netMerchantAmount === undefined
      ? undefined
      : decimal(row.netMerchantAmount as never).toFixed(4),
    ownershipMode: ownershipModeOf(row),
    mismatchTolerance: toleranceOf(row),
    feeAccrual: feeAccrualOf(row),
  };
};

export const attemptRowToDynamicAttempt = (row: AttemptRow): DynamicAttempt => toAttempt(row);

/** A compare-and-set status write found the attempt in another status than the caller observed. */
export class AttemptStateConflictError extends Error {
  readonly code = "ATTEMPT_STATE_CONFLICT";
  readonly statusCode = 409;

  constructor(readonly attemptId: string, readonly expectedStatus: string) {
    super(`Attempt ${attemptId} is no longer ${expectedStatus}`);
    this.name = "AttemptStateConflictError";
  }
}

export class PrismaAttemptRepository implements AttemptRepository {
  private readonly client: PrismaLike;

  constructor(client: PrismaLike) {
    this.client = client;
  }

  async getAttempt(attemptId: string): Promise<DynamicAttempt | null> {
    const row = await this.client.paymentAttempt.findUnique({
      where: { id: attemptId },
      include: {
        gatewayVersion: { include: { setting: true, gateway: { select: { id: true, kind: true } } } },
        route: { select: { mismatchPolicy: true, costModel: true } },
      },
    }) as AttemptRow | null;
    return row ? toAttempt(row) : null;
  }

  /**
   * Single-writer finalization claim: only one transaction can move the
   * attempt out of its observed status. A concurrent duplicate callback then
   * fails the claim instead of settling and consuming the link slot twice.
   */
  async claimFinalize(
    attemptId: string,
    expectedStatus: string,
    transaction?: unknown,
  ): Promise<boolean> {
    const target = (transaction ?? this.client) as PrismaLike;
    // FAILED and EXPIRED always carry `terminal_at`, and they are exactly the states a late
    // success recovers from. Requiring `terminal_at IS NULL` for them made the claim match
    // nothing, so a verified "paid" callback for such an attempt was refused with a 409 and
    // dropped: the payer was charged and nothing was booked. The status comparison alone is
    // the single-writer guard there (the winner moves the row to SUCCEEDED before it commits).
    const lateSuccess = expectedStatus === "FAILED" || expectedStatus === "EXPIRED";
    const result = await target.paymentAttempt.updateMany({
      where: { id: attemptId, status: expectedStatus, ...(lateSuccess ? {} : { terminalAt: null }) },
      data: { substatus: "FINALIZING" },
    });
    return Number(result?.count ?? 0) === 1;
  }

  async updateAttempt(
    attemptId: string,
    patch: DynamicAttemptPatch,
    transaction?: unknown,
  ): Promise<DynamicAttempt> {
    const target = (transaction ?? this.client) as PrismaLike;
    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.substatus !== undefined) data.substatus = patch.substatus;
    if (patch.clearSubstatus) data.substatus = null;
    if (patch.canonicalError !== undefined) data.substatus = patch.canonicalError;
    if (patch.otpAttempts !== undefined) data.otpAttempts = patch.otpAttempts;
    if (patch.ledgerEntryId !== undefined) data.ledgerEntryId = patch.ledgerEntryId;
    if (patch.contextCiphertext !== undefined) data.contextCiphertext = patch.contextCiphertext;
    if (patch.publicOutputs !== undefined) data.publicOutputs = patch.publicOutputs;
    if (patch.providerReference !== undefined) data.providerReference = patch.providerReference;
    if (patch.networkReference !== undefined) data.networkReference = patch.networkReference;
    if (patch.settledAmount !== undefined) data.settledAmount = patch.settledAmount;
    if (patch.gatewayFeeAmount !== undefined) data.gatewayFeeAmount = patch.gatewayFeeAmount;
    if (patch.pointOfNoReturn !== undefined) data.pointOfNoReturn = patch.pointOfNoReturn;

    if (data.status !== undefined) {
      const terminal = ["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED", "REFUNDED"];
      if (terminal.includes(String(data.status))) {
        data.terminalAt = new Date();
        data.nextCheckAt = null;
      }
    }

    const include = {
      gatewayVersion: { include: { setting: true, gateway: { select: { id: true, kind: true } } } },
      route: { select: { mismatchPolicy: true, costModel: true } },
    };
    let row: AttemptRow;
    if (patch.expectedStatus !== undefined) {
      // Compare-and-set: the write only lands while the row still has the status the caller
      // observed. A status read before a slow gateway call can be stale by the time the answer
      // arrives (a verified webhook may have settled the attempt meanwhile); an unconditional
      // write would then put UNKNOWN or FAILED over a committed SUCCEEDED.
      const changed = await target.paymentAttempt.updateMany({
        where: { id: attemptId, status: patch.expectedStatus },
        data,
      });
      if (Number(changed?.count ?? 0) === 0) {
        throw new AttemptStateConflictError(attemptId, patch.expectedStatus);
      }
      row = await target.paymentAttempt.findUnique({ where: { id: attemptId }, include }) as AttemptRow;
    } else {
      row = await target.paymentAttempt.update({ where: { id: attemptId }, data, include }) as AttemptRow;
    }
    const terminal = ["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED", "REFUNDED"];
    if (data.status !== undefined && terminal.includes(String(data.status))) {
      await enqueueOutboxEvent(target, {
        topic: "attempt.transitioned",
        aggregateType: "PAYMENT_ATTEMPT",
        aggregateId: String(row.id),
        merchantId: row.merchantId ? String(row.merchantId) : null,
        payload: {
          event: "terminal",
          attemptId: String(row.id),
          merchantId: row.merchantId ? String(row.merchantId) : null,
          routeId: row.routeId ? String(row.routeId) : null,
          currency: String(row.currency),
          status: String(row.status),
          substatus: row.substatus ?? null,
          totalChargedAmount: row.totalChargedAmount,
          netMerchantAmount: row.netMerchantAmount,
          occurredAt: (row.status === "SUCCEEDED" || row.status === "FAILED" ? new Date() : new Date()).toISOString(),
        },
      });
    }
    return toAttempt(row);
  }
}
