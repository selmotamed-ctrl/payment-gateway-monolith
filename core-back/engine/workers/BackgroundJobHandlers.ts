import { ApiError } from "../../lib/error";
import { moneyToString } from "../db/money";
import type { BackgroundJobRow, PrismaLike, Repositories, Tx } from "../db/ports";
import {
  executeApprovalSubject,
  openDisputeWithDraftedAdjustment,
  SYSTEM_AUTOMATION_USER_ID,
  type GovernanceExecutionContext,
  type ReconciliationSchedulerLike,
  type RefundExecutionEngine,
} from "../governance/GovernanceExecution";
import { getPlatformRuntime } from "../runtime";
import { decimal, LedgerPoster } from "../ledger/LedgerPoster";
import {
  StatementIngestor,
  type FeeVariancePoster,
} from "../reconciliation/StatementIngestor";
import type { BackgroundJobHandler } from "./BackgroundJobWorker";

/**
 * The payload of a dispute intake job.
 *
 * The intake is executed by a worker, so everything the execution needs is
 * recorded by the request that queued it.
 */
export interface DisputeIntakeJobPayload {
  kind: "DISPUTE_INTAKE";
  attemptId: string;
  gatewayId: string;
  railId: string;
  externalDisputeRef: string;
  source: "WEBHOOK" | "STATEMENT" | "MANUAL";
  reasonCode: string | null;
  amount: string;
  currency: string;
  actorUserId: string | null;
  actorRole: string | null;
}

/**
 * The payload of an adjustment execution job.
 *
 * The job never carries a checker of its own: the checker is the one the
 * request recorded on the approval request.
 */
export interface AdjustmentExecutionJobPayload {
  kind: "ADJUSTMENT_EXECUTION";
  approvalRequestId: string;
  outcome?: "WON" | "LOST" | null;
  notes?: string | null;
  /**
   * The role of the checker at the time of the request. It is only a
   * fallback: the authoritative role is the one of the recorded checker.
   */
  checkerRole?: string | null;
}

export type AdjustmentJobPayload = DisputeIntakeJobPayload | AdjustmentExecutionJobPayload;

/**
 * The fee variance true-up of a reconciliation run.
 *
 * The variance between the fee of the statement and the accrued fee of the
 * attempt is booked through the ledger. The posting is keyed by the attempt,
 * so a retried reconciliation never books the same variance twice.
 */
export const createFeeVariancePoster = (ledgerPoster: LedgerPoster): FeeVariancePoster => ({
  async postFeeVariance(posting) {
    const variance = moneyToString(posting.variance);
    if (variance === "0.0000") {
      return { journalEntryId: null };
    }
    const result = await ledgerPoster.postScenario(
      "FEE_VARIANCE_TRUE_UP",
      posting.attemptId ?? `fee-variance:${posting.statementSourceId}`,
      { amount: "0.0001", varianceAmount: variance },
      {
        gatewayId: posting.gatewayId,
      },
    );
    return { journalEntryId: result.entry.id };
  },
});

const parserConfigOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * A statement source that settles in a T+N batch.
 *
 * The parser configuration is the declarative flag (`supports_batch_net`);
 * the settlement lag is accepted too, because a source with a positive lag
 * is by definition settled after the payment day.
 */
const isBatchSettlementSource = (
  source: { parserConfig: unknown; settlementLagDays: number },
): boolean => {
  const config = parserConfigOf(source.parserConfig);
  const flag = config.supportsBatchNet ?? config.supports_batch_net;
  return Boolean(flag) || Number(source.settlementLagDays ?? 0) > 0;
};

/**
 * Posts the T+N bank statement settlement sweep of a reconciliation run.
 *
 * The statement amount is the gross amount the gateway cleared and the
 * statement fee is the accrued gateway fee, so the sweep is
 * `Dr TREASURY <settled> / Dr GATEWAY_FEE_ACCRUAL <fee> /
 *  Cr GATEWAY_CLEARING <gross>` (design §11.3 entry 3). The ledger dedupes on
 * `(refType, refId)`, so a retried job never books a sweep twice.
 */
const postSettlementSweeps = async (
  deps: ReconciliationJobHandlerDeps,
  run: { id: string; statementSourceId: string },
): Promise<number> => {
  const source = await deps.repositories.reconciliation.findStatementSourceById(
    deps.db as Tx,
    run.statementSourceId,
  );
  if (!source) {
    return 0;
  }
  const batchSource = isBatchSettlementSource(source);
  const items = await deps.repositories.reconciliation.listItemsByRun(deps.db as Tx, run.id);
  const candidates = batchSource ? items : items.filter((item) => Boolean(item.batchReference));
  if (candidates.length === 0) {
    return 0;
  }
  const poster = deps.ledgerPoster ?? new LedgerPoster(deps.db as never);
  const seen = new Set<string>();
  let posted = 0;
  for (const item of candidates) {
    if (item.result === "DUPLICATE") {
      continue;
    }
    const gross = decimal(item.statementAmount as never);
    const fee = decimal(item.statementFee as never);
    if (!gross.gt(0)) {
      continue;
    }
    const settled = gross.minus(fee);
    if (!settled.gt(0)) {
      continue;
    }
    const refId = item.batchReference
      ? `settlement:${item.batchReference}`
      : `settlement:${item.id}`;
    if (seen.has(refId)) {
      continue;
    }
    seen.add(refId);
    await poster.postScenario(
      "SETTLEMENT_SWEEP",
      refId,
      {
        amount: gross.toFixed(4),
        gatewayFeeAmount: fee.toFixed(4),
        settledAmount: settled.toFixed(4),
      },
      { gatewayId: String(source.gatewayId) },
    );
    posted += 1;
  }
  return posted;
};

export interface ReconciliationJobHandlerDeps {
  db: PrismaLike;
  repositories: Repositories;
  feeVariancePoster?: FeeVariancePoster;
  ledgerPoster?: LedgerPoster;
  clock?: () => Date;
  logger?: { info: (message: string, meta?: Record<string, unknown>) => void };
}

export interface AdjustmentJobHandlerDeps {
  db: PrismaLike;
  ledgerPoster: LedgerPoster;
  repositories: Repositories;
  engine?: RefundExecutionEngine;
  reconciliationScheduler?: ReconciliationSchedulerLike;
  clock?: () => Date;
  logger?: { info: (message: string, meta?: Record<string, unknown>) => void };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const toBuffer = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    return Buffer.from(value, "base64");
  }
  return Buffer.alloc(0);
};

/**
 * The handler of a `RECONCILIATION_RUN` job.
 *
 * The job parses the uploaded statement, matches it against the local
 * attempts and posts the fee variance. The ingestion is idempotent: the run
 * is marked with `ingested_at` inside the very transaction that writes the
 * report items, so a retried job never matches the same statement twice and
 * never posts the fee variance twice.
 */
export const createReconciliationJobHandler = (
  deps: ReconciliationJobHandlerDeps,
): BackgroundJobHandler => ({
  async handle(job: BackgroundJobRow): Promise<void> {
    const run = await deps.repositories.reconciliation.findRunById(deps.db as Tx, job.referenceId);
    if (!run) {
      throw new ApiError(404, "RECONCILIATION_RUN_NOT_FOUND", "The reconciliation run does not exist");
    }
    if (run.ingestedAt) {
      // The run is committed; a retried job still re-attempts the settlement
      // sweep, which the ledger dedupes, so a failure after ingestion is not
      // lost.
      await postSettlementSweeps(deps, run);
      deps.logger?.info("BackgroundJobWorker: reconciliation run was already ingested", {
        runId: run.id,
      });
      return;
    }
    if (!run.fileContent) {
      throw new ApiError(409, "RECONCILIATION_FILE_MISSING", "The reconciliation run carries no statement file");
    }
    const ingestor = new StatementIngestor({
      db: deps.db,
      repositories: deps.repositories,
      feeVariancePoster: deps.feeVariancePoster,
      clock: deps.clock,
    });
    const result = await ingestor.ingest({
      statementSourceId: run.statementSourceId,
      content: toBuffer(run.fileContent),
      fileName: run.fileName ?? undefined,
      windowStart: run.windowStart,
      windowEnd: run.windowEnd,
      runId: run.id,
    });
    const settlementSweeps = await postSettlementSweeps(deps, run);
    deps.logger?.info("BackgroundJobWorker: reconciliation run finished", {
      runId: result.runId,
      totalRows: result.totalRows,
      matched: result.matched,
      amountMismatch: result.amountMismatch,
      missingAtGateway: result.missingAtGateway,
      missingLocally: result.missingLocally,
      feeVariances: result.feeVariances,
      settlementSweeps,
      idempotent: result.idempotent,
    });
  },
});

/**
 * The handler of an `ADJUSTMENT_EXECUTION` job.
 *
 * It executes two kinds of work:
 *
 *  - the dispute intake (the dispute, the drafted chargeback adjustment, the
 *    approval request, the reserve posting and the audit trail), and
 *  - the execution of an approved adjustment (the ledger posting, the state
 *    change of the adjustment and the dispute and the audit trail).
 *
 * Both run inside one transaction, so the money movement and the state
 * change that authorises it commit together.
 */
export const createAdjustmentJobHandler = (
  deps: AdjustmentJobHandlerDeps,
): BackgroundJobHandler => ({
  async handle(job: BackgroundJobRow): Promise<void> {
    const payload = parseAdjustmentPayload(job);
    const engine: RefundExecutionEngine = deps.engine ?? {
      // Resolved lazily so a dispute intake or a chargeback never builds the
      // rail engine; an approved refund shares the platform engine and calls
      // the very gateway stack the payment used.
      refund: async (attempt, amount, adjustmentId) =>
        getPlatformRuntime(deps.db as never).engine.refund(attempt as never, amount, adjustmentId),
    };
    const context: GovernanceExecutionContext = {
      ledgerPoster: deps.ledgerPoster,
      repositories: deps.repositories,
      engine,
      reconciliationScheduler: deps.reconciliationScheduler,
    };
    if (payload.kind === "DISPUTE_INTAKE") {
      await executeDisputeIntake(deps, context, payload);
      return;
    }
    await executeApprovedAdjustment(deps, context, payload);
  },
});

const parseAdjustmentPayload = (job: BackgroundJobRow): AdjustmentJobPayload => {
  const payload = asRecord(job.payloadJson);
  const kind = String(payload.kind ?? "");
  if (kind === "DISPUTE_INTAKE") {
    return {
      kind: "DISPUTE_INTAKE",
      attemptId: String(payload.attemptId ?? ""),
      gatewayId: String(payload.gatewayId ?? ""),
      railId: String(payload.railId ?? ""),
      externalDisputeRef: String(payload.externalDisputeRef ?? ""),
      source: (String(payload.source ?? "MANUAL") as DisputeIntakeJobPayload["source"]),
      reasonCode: payload.reasonCode === undefined || payload.reasonCode === null
        ? null
        : String(payload.reasonCode),
      amount: String(payload.amount ?? "0"),
      currency: String(payload.currency ?? "LYD"),
      actorUserId: payload.actorUserId === undefined || payload.actorUserId === null
        ? null
        : String(payload.actorUserId),
      actorRole: payload.actorRole === undefined || payload.actorRole === null
        ? null
        : String(payload.actorRole),
    };
  }
  if (kind === "ADJUSTMENT_EXECUTION") {
    return {
      kind: "ADJUSTMENT_EXECUTION",
      approvalRequestId: String(payload.approvalRequestId ?? ""),
      outcome: payload.outcome === undefined || payload.outcome === null
        ? null
        : (String(payload.outcome) as "WON" | "LOST"),
      notes: payload.notes === undefined || payload.notes === null ? null : String(payload.notes),
      checkerRole: payload.checkerRole === undefined || payload.checkerRole === null
        ? null
        : String(payload.checkerRole),
    };
  }
  throw new ApiError(400, "BACKGROUND_JOB_PAYLOAD_INVALID", `Unknown adjustment job kind '${kind}'`);
};

/**
 * Opens the dispute and drafts the chargeback adjustment.
 *
 * The dispute is de-duplicated on `(gateway_id, external_dispute_ref)`, so a
 * retried job that finds the dispute already open is a no-op instead of a
 * failure.
 */
const executeDisputeIntake = async (
  deps: AdjustmentJobHandlerDeps,
  context: GovernanceExecutionContext,
  payload: DisputeIntakeJobPayload,
): Promise<void> => {
  await deps.db.$transaction(async (tx: Tx) => {
    try {
      const result = await openDisputeWithDraftedAdjustment(context, tx as never, {
        attemptId: payload.attemptId,
        gatewayId: payload.gatewayId,
        railId: payload.railId,
        externalDisputeRef: payload.externalDisputeRef,
        source: payload.source,
        reasonCode: payload.reasonCode,
        amount: decimal(payload.amount),
        currency: payload.currency,
        actorUserId: payload.actorUserId,
        actorRole: payload.actorRole,
      });
      deps.logger?.info("BackgroundJobWorker: dispute intake finished", {
        disputeId: result.disputeId,
        adjustmentId: result.adjustmentId,
        escrowed: result.escrowed,
      });
    } catch (error) {
      if (isDisputeAlreadyExists(error)) {
        deps.logger?.info("BackgroundJobWorker: dispute was already opened", {
          externalDisputeRef: payload.externalDisputeRef,
        });
        return;
      }
      throw error;
    }
  });
};

/**
 * Executes an approved adjustment.
 *
 * The checker is the one the request recorded on the approval request: the
 * job never invents one, and the maker-checker separation is enforced again
 * by the governance execution itself.
 */
const executeApprovedAdjustment = async (
  deps: AdjustmentJobHandlerDeps,
  context: GovernanceExecutionContext,
  payload: AdjustmentExecutionJobPayload,
): Promise<void> => {
  await deps.db.$transaction(async (tx: Tx) => {
    const approval = await deps.repositories.governance.findApprovalRequestById(tx, payload.approvalRequestId);
    if (!approval) {
      throw new ApiError(404, "APPROVAL_REQUEST_NOT_FOUND", "The approval request does not exist");
    }
    const checkerUserId = approval.checkerUserId;
    if (!checkerUserId) {
      throw new ApiError(
        409,
        "APPROVAL_CHECKER_MISSING",
        "The approval request carries no checker, so the execution cannot run",
      );
    }
    if (checkerUserId === SYSTEM_AUTOMATION_USER_ID) {
      throw new ApiError(403, "AUTOMATION_CANNOT_ACT_AS_CHECKER", "System automation can never act as a checker");
    }
    const checker = await deps.repositories.identity.findUserById(tx, checkerUserId);
    const checkerRole = checker?.role ?? payload.checkerRole ?? null;
    const result = await executeApprovalSubject(context, tx as never, {
      approval: {
        id: approval.id,
        subjectType: approval.subjectType,
        subjectId: approval.subjectId,
        payloadDiffJson: approval.payloadDiffJson,
        makerUserId: approval.makerUserId,
      },
      checkerUserId,
      checkerRole: checkerRole ?? "",
      notes: payload.notes ?? null,
      outcome: payload.outcome ?? null,
    });
    const state = result.status === "HELD" ? "PENDING_REVIEW" : "EXECUTED";
    await deps.repositories.governance.updateApprovalRequest(tx, approval.id, { state });
    deps.logger?.info("BackgroundJobWorker: adjustment execution finished", {
      approvalRequestId: approval.id,
      status: result.status,
      reason: result.reason ?? null,
      journalEntryId: result.journalEntryId ?? null,
      idempotent: result.idempotent === true,
    });
  });
};

const isDisputeAlreadyExists = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "DISPUTE_ALREADY_EXISTS";
};
