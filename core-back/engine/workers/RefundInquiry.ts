import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { ApiError } from "../../lib/error";
import { toCamelRows } from "../db/rawRows";
import type { BackgroundJobRow, PrismaLike, Repositories, Tx } from "../db/ports";
import type { ReconciliationScheduler } from "../flow/DynamicRailEngine";
import {
  failReconciledRefundAdjustment,
  finalizeReconciledRefundAdjustment,
  type GovernanceExecutionContext,
  type ReconciliationSchedulerLike,
  type RefundExecutionEngine,
} from "../governance/GovernanceExecution";
import type { LedgerPoster } from "../ledger/LedgerPoster";
import { ensureLedgerSystemActor, inTransaction, writeSystemAudit } from "../ledger/ledgerAlerts";
import { openKeyedOperatorCase } from "./automationCases";
import type { BackgroundJobHandler } from "./BackgroundJobWorker";

/**
 * AUTO-20: refunds stuck in EXECUTING.
 *
 * A refund whose gateway answer was UNKNOWN (or an ambiguous FAILED) stays
 * EXECUTING: it is never booked and never released until the outcome is
 * known. The `ReconciliationScheduler` below turns that state into a chain of
 * durable `REFUND_INQUIRY` background jobs: every job inquires the gateway
 * once; a definitive answer finalises (books) or fails (rejects) the
 * adjustment through the governance path; an open answer enqueues the next
 * check with backoff; when the inquiry window elapses, or the rail cannot be
 * asked at all, ONE keyed operator case is opened and the adjustment stays
 * EXECUTING for a person to decide.
 */

export const REFUND_INQUIRY_JOB_TYPE = "REFUND_INQUIRY" as const;
export const REFUND_INQUIRY_REFERENCE_TYPE = "ADJUSTMENT";
export const REFUND_INQUIRY_SUBJECT_KEY = (adjustmentId: string): string => `refund.inquiry:${adjustmentId}`;

export const DEFAULT_REFUND_INQUIRY_FIRST_CHECK_SECONDS = 60;
export const DEFAULT_REFUND_INQUIRY_BACKOFF_SECONDS: readonly number[] = [60, 300, 900, 1800, 3600];
export const DEFAULT_REFUND_INQUIRY_WINDOW_SECONDS = 24 * 60 * 60;
export const DEFAULT_REFUND_INQUIRY_CASE_SLA_HOURS = 24;
export const DEFAULT_REFUND_INQUIRY_JOB_MAX_ATTEMPTS = 5;

export interface RefundInquiryJobPayload {
  kind: typeof REFUND_INQUIRY_JOB_TYPE;
  adjustmentId: string;
  attemptId: string;
  /** 0 for the first check of a chain, +1 for every follow-up. */
  check: number;
  /** Start of the inquiry window; also identifies the chain. ISO-8601. */
  windowStartedAt: string;
}

// ---------------------------------------------------------------------------
// Job store
// ---------------------------------------------------------------------------

/**
 * Durable storage of the inquiry chain. Both operations are idempotent, so a
 * repeated `schedule` (the engine and the governance path both call it) or a
 * re-run of a job after a crash never doubles the chain.
 */
export interface RefundInquiryJobStore {
  /** Enqueues the first check unless a live (QUEUED/RUNNING) inquiry exists. */
  enqueueInitial(payload: RefundInquiryJobPayload, availableAt: Date, maxAttempts: number): Promise<boolean>;
  /** Enqueues check N of a chain unless check N (or later) of that chain exists. */
  enqueueFollowUp(payload: RefundInquiryJobPayload, availableAt: Date, maxAttempts: number): Promise<boolean>;
}

const insertInquiryJob = async (
  tx: PrismaLike,
  payload: RefundInquiryJobPayload,
  availableAt: Date,
  maxAttempts: number,
  now: Date,
): Promise<void> => {
  // Raw SQL: the job type is a new enum value the generated client may not
  // know yet, and `id` / `updated_at` have no database default.
  await tx.$executeRawUnsafe(
    "INSERT INTO background_jobs"
      + " (id, created_at, updated_at, job_type, reference_type, reference_id, payload_json, state, attempts, max_attempts, available_at)"
      + " VALUES ($1::uuid, $2, $2, 'REFUND_INQUIRY'::\"BackgroundJobType\", $3, $4, $5::jsonb, 'QUEUED', 0, $6, $7)",
    randomUUID(),
    now,
    REFUND_INQUIRY_REFERENCE_TYPE,
    payload.adjustmentId,
    JSON.stringify(payload),
    maxAttempts,
    availableAt,
  );
};

const lockAdjustmentChain = async (tx: PrismaLike, adjustmentId: string): Promise<void> => {
  await tx.$queryRawUnsafe(
    "SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS l",
    `refund-inquiry:${adjustmentId}`,
  );
};

export const createDbRefundInquiryJobStore = (
  db: PrismaLike,
  clock: () => Date = () => new Date(),
): RefundInquiryJobStore => ({
  enqueueInitial: (payload, availableAt, maxAttempts) =>
    inTransaction(db, async (tx) => {
      await lockAdjustmentChain(tx as PrismaLike, payload.adjustmentId);
      const live = await tx.$queryRawUnsafe(
        "SELECT id FROM background_jobs"
          + " WHERE job_type::text = 'REFUND_INQUIRY' AND reference_type = $1 AND reference_id = $2"
          + " AND state IN ('QUEUED', 'RUNNING') LIMIT 1",
        REFUND_INQUIRY_REFERENCE_TYPE,
        payload.adjustmentId,
      );
      if (Array.isArray(live) && live.length > 0) return false;
      await insertInquiryJob(tx as PrismaLike, payload, availableAt, maxAttempts, clock());
      return true;
    }),
  enqueueFollowUp: (payload, availableAt, maxAttempts) =>
    inTransaction(db, async (tx) => {
      await lockAdjustmentChain(tx as PrismaLike, payload.adjustmentId);
      const existing = await tx.$queryRawUnsafe(
        "SELECT id FROM background_jobs"
          + " WHERE job_type::text = 'REFUND_INQUIRY' AND reference_type = $1 AND reference_id = $2"
          + " AND payload_json->>'windowStartedAt' = $3"
          + " AND (payload_json->>'check')::int >= $4 LIMIT 1",
        REFUND_INQUIRY_REFERENCE_TYPE,
        payload.adjustmentId,
        payload.windowStartedAt,
        payload.check,
      );
      if (Array.isArray(existing) && existing.length > 0) return false;
      await insertInquiryJob(tx as PrismaLike, payload, availableAt, maxAttempts, clock());
      return true;
    }),
});

// ---------------------------------------------------------------------------
// Scheduler (the ReconciliationScheduler implementation)
// ---------------------------------------------------------------------------

interface Logger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface RefundInquirySchedulerOptions {
  db: PrismaLike;
  store?: RefundInquiryJobStore;
  clock?: () => Date;
  /** Delay of the first check. Default 60 s. */
  firstCheckAfterSeconds?: number;
  /** Worker-level retries of one check (DB errors and the like). Default 5. */
  jobMaxAttempts?: number;
  logger?: Logger;
}

/**
 * The production `ReconciliationScheduler`: pass it as
 * `reconciliationScheduler` to the `DynamicRailEngine` and to every
 * `GovernanceExecutionContext`. It never throws into the refund path: a
 * failure to enqueue is logged, and `findExecutingRefundsWithoutInquiry`
 * lets the platform monitor find the refund.
 */
export const createRefundInquiryScheduler = (
  options: RefundInquirySchedulerOptions,
): ReconciliationScheduler & ReconciliationSchedulerLike => {
  const clock = options.clock ?? (() => new Date());
  const store = options.store ?? createDbRefundInquiryJobStore(options.db, clock);
  const firstCheckAfterSeconds = options.firstCheckAfterSeconds ?? DEFAULT_REFUND_INQUIRY_FIRST_CHECK_SECONDS;
  const maxAttempts = options.jobMaxAttempts ?? DEFAULT_REFUND_INQUIRY_JOB_MAX_ATTEMPTS;
  const logger = options.logger ?? silentLogger;
  return {
    async schedule(attemptId: string, adjustmentId?: string): Promise<void> {
      if (!adjustmentId) {
        logger.warn("RefundInquiryScheduler: no adjustment to inquire", { attemptId });
        return;
      }
      const now = clock();
      try {
        const enqueued = await store.enqueueInitial(
          {
            kind: REFUND_INQUIRY_JOB_TYPE,
            adjustmentId,
            attemptId,
            check: 0,
            windowStartedAt: now.toISOString(),
          },
          new Date(now.getTime() + firstCheckAfterSeconds * 1000),
          maxAttempts,
        );
        logger.info("RefundInquiryScheduler: refund inquiry scheduled", { attemptId, adjustmentId, enqueued });
      } catch (error) {
        logger.error("RefundInquiryScheduler: unable to schedule the refund inquiry", {
          attemptId,
          adjustmentId,
          error: (error as Error).message,
        });
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Handler ports
// ---------------------------------------------------------------------------

export interface RefundInquiryOutcome {
  /** SUCCEEDED: the gateway refunded; FAILED: it did not; UNKNOWN: still open. */
  status: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  /** Only a definitive answer finalises or fails the adjustment. */
  definitive: boolean;
  /** false when the rail offers no way to ask; the case is opened at once. */
  supported?: boolean;
  ownershipMode?: string | null;
  detail?: string;
}

export interface RefundInquiryPort {
  inquire(input: { adjustmentId: string; attemptId: string; amount: string; check: number }): Promise<RefundInquiryOutcome>;
}

export interface RefundAdjustmentSnapshot {
  id: string;
  type: string;
  state: string;
  sourceAttemptId: string | null;
  amount: string;
}

export interface RefundAdjustmentReader {
  find(adjustmentId: string): Promise<RefundAdjustmentSnapshot | null>;
}

export interface RefundResolutionPort {
  finalize(input: { adjustmentId: string; ownershipMode?: string | null }): Promise<{ status: string; reason?: string }>;
  fail(input: { adjustmentId: string; reason: string }): Promise<{ status: string; reason?: string }>;
}

export interface RefundInquiryCaseOpener {
  open(input: { adjustmentId: string; attemptId: string; reason: string; now: Date }): Promise<{ caseId: string | null; created: boolean }>;
}

export const createDbRefundAdjustmentReader = (db: PrismaLike): RefundAdjustmentReader => ({
  async find(adjustmentId) {
    const rows = toCamelRows<{ id: string; type: string; state: string; sourceAttemptId: string | null; amount: unknown }>(
      await db.$queryRawUnsafe(
        "SELECT id, type::text AS type, state::text AS state, source_attempt_id, amount::text AS amount"
          + " FROM adjustments WHERE id = $1::uuid",
        adjustmentId,
      ),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      type: String(row.type),
      state: String(row.state),
      sourceAttemptId: row.sourceAttemptId ? String(row.sourceAttemptId) : null,
      amount: String(row.amount),
    };
  },
});

/** Finalises or fails through `GovernanceExecution`, acting as the system principal. */
export const createGovernanceRefundResolution = (deps: {
  db: PrismaLike;
  ledgerPoster: LedgerPoster;
  repositories: Repositories;
}): RefundResolutionPort => {
  const context: GovernanceExecutionContext = { ledgerPoster: deps.ledgerPoster, repositories: deps.repositories };
  return {
    async finalize(input) {
      const actorUserId = await ensureLedgerSystemActor(deps.db);
      const result = await finalizeReconciledRefundAdjustment(
        context,
        deps.db as Tx,
        { adjustmentId: input.adjustmentId, actorUserId, actorRole: "SYSTEM" },
        { status: "REFUNDED", attempt: input.ownershipMode ? { ownershipMode: input.ownershipMode } : null },
      );
      return { status: result.status, reason: result.reason };
    },
    async fail(input) {
      const actorUserId = await ensureLedgerSystemActor(deps.db);
      const result = await failReconciledRefundAdjustment(context, deps.db as Tx, {
        adjustmentId: input.adjustmentId,
        actorUserId,
        actorRole: "SYSTEM",
        reason: input.reason,
      });
      return { status: result.status, reason: result.reason };
    },
  };
};

/** One keyed P1 case per adjustment, with its audit row in the same transaction. */
export const createDbRefundInquiryCaseOpener = (options: {
  db: PrismaLike;
  slaHours?: number;
  priority?: "P1" | "P2" | "P3";
}): RefundInquiryCaseOpener => {
  const slaHours = options.slaHours ?? DEFAULT_REFUND_INQUIRY_CASE_SLA_HOURS;
  const priority = options.priority ?? "P1";
  return {
    open: (input) =>
      inTransaction(options.db, async (tx) => {
        const result = await openKeyedOperatorCase(tx as PrismaLike, {
          kind: "MANUAL_REVIEW",
          priority,
          subjectKey: REFUND_INQUIRY_SUBJECT_KEY(input.adjustmentId),
          attemptId: input.attemptId,
          slaHours,
          now: input.now,
          notes:
            `Refund adjustment ${input.adjustmentId} is stuck in EXECUTING: ${input.reason}. `
            + "Confirm with the gateway or the statement whether the refund was paid, then book or reject it. "
            + "It still counts against the refundable amount until then.",
        });
        if (result.created) {
          await writeSystemAudit(tx, {
            action: "REFUND_INQUIRY_ESCALATED",
            entityType: "ADJUSTMENT",
            entityId: input.adjustmentId,
            before: { state: "EXECUTING" },
            after: { state: "EXECUTING", operatorCaseId: result.id, priority, slaHours, reason: input.reason },
          });
        }
        return { caseId: result.id, created: result.created };
      }),
  };
};

/**
 * The production inquiry port. The rail flow has no refund-status phase, so
 * the only safe way to ask is to replay the refund with the same adjustment id
 * (the REFUND step receives it as its idempotency key) - and only on a rail
 * whose capabilities declare `refund_idempotent: true`. Any other rail is
 * reported as unsupported, so the case is opened immediately. A replayed
 * FAILED is not treated as definitive: the first call may still have paid.
 */
export const createEngineRefundInquiryPort = (options: {
  db: PrismaLike;
  engine: RefundExecutionEngine;
  replayCapability?: string;
}): RefundInquiryPort => {
  const capability = options.replayCapability ?? "refund_idempotent";
  return {
    async inquire(input) {
      const rows = toCamelRows<{ id: string; capabilities: unknown }>(
        await options.db.$queryRawUnsafe(
          "SELECT a.id, r.capabilities FROM payment_attempts a LEFT JOIN rails r ON r.id = a.rail_id WHERE a.id = $1::uuid",
          input.attemptId,
        ),
      );
      const row = rows[0];
      if (!row) {
        return { status: "UNKNOWN", definitive: false, supported: false, detail: "The refunded attempt does not exist" };
      }
      const capabilities = row.capabilities && typeof row.capabilities === "object"
        ? (row.capabilities as Record<string, unknown>)
        : {};
      if (capabilities[capability] !== true) {
        return {
          status: "UNKNOWN",
          definitive: false,
          supported: false,
          detail: `The rail offers no refund inquiry (capability '${capability}' is not declared)`,
        };
      }
      const result = await options.engine.refund({ id: input.attemptId }, new Decimal(input.amount), input.adjustmentId);
      const status = String(result.status ?? "").toUpperCase();
      if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED" || status === "SUCCEEDED") {
        return { status: "SUCCEEDED", definitive: true, ownershipMode: result.attempt?.ownershipMode ?? null };
      }
      return { status: "UNKNOWN", definitive: false, detail: `The replayed refund answered ${status || "nothing"}` };
    },
  };
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface RefundInquiryJobHandlerDeps {
  db: PrismaLike;
  inquiry: RefundInquiryPort;
  /** Needed by the default resolution port. */
  ledgerPoster?: LedgerPoster;
  repositories?: Repositories;
  store?: RefundInquiryJobStore;
  adjustments?: RefundAdjustmentReader;
  resolution?: RefundResolutionPort;
  cases?: RefundInquiryCaseOpener;
  clock?: () => Date;
  logger?: Logger;
  /** Delay before check N+1 (the last value repeats). Default 60, 300, 900, 1800, 3600 s. */
  backoffSeconds?: readonly number[];
  /** How long the gateway is asked before an operator takes over. Default 24 h. */
  windowSeconds?: number;
  caseSlaHours?: number;
  casePriority?: "P1" | "P2" | "P3";
  jobMaxAttempts?: number;
  /**
   * Dry run: a definitive answer is audited (`REFUND_INQUIRY_DRY_RUN`, with
   * what would have been done) and handed to an operator case instead of
   * finalising or failing the adjustment. Default false.
   */
  dryRun?: boolean;
  /** Audit writer of the dry run (default `writeSystemAudit` on `db`). */
  audit?: (input: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown }) => Promise<void>;
}

export const parseRefundInquiryPayload = (job: BackgroundJobRow): RefundInquiryJobPayload => {
  const raw = job.payloadJson && typeof job.payloadJson === "object" && !Array.isArray(job.payloadJson)
    ? (job.payloadJson as Record<string, unknown>)
    : {};
  const adjustmentId = String(raw.adjustmentId ?? job.referenceId ?? "");
  const attemptId = String(raw.attemptId ?? "");
  const windowStartedAt = String(raw.windowStartedAt ?? "");
  const check = Number(raw.check ?? 0);
  if (!adjustmentId || !attemptId || Number.isNaN(new Date(windowStartedAt).getTime()) || !Number.isInteger(check) || check < 0) {
    throw new ApiError(400, "BACKGROUND_JOB_PAYLOAD_INVALID", "The refund inquiry job payload is invalid");
  }
  return { kind: REFUND_INQUIRY_JOB_TYPE, adjustmentId, attemptId, check, windowStartedAt };
};

/** The handler of a `REFUND_INQUIRY` job: one gateway inquiry per job. */
export const createRefundInquiryJobHandler = (deps: RefundInquiryJobHandlerDeps): BackgroundJobHandler => {
  const clock = deps.clock ?? (() => new Date());
  const logger = deps.logger ?? silentLogger;
  const store = deps.store ?? createDbRefundInquiryJobStore(deps.db, clock);
  const adjustments = deps.adjustments ?? createDbRefundAdjustmentReader(deps.db);
  const cases = deps.cases ?? createDbRefundInquiryCaseOpener({
    db: deps.db,
    slaHours: deps.caseSlaHours,
    priority: deps.casePriority,
  });
  const backoff = deps.backoffSeconds && deps.backoffSeconds.length > 0
    ? deps.backoffSeconds
    : DEFAULT_REFUND_INQUIRY_BACKOFF_SECONDS;
  const windowMs = (deps.windowSeconds ?? DEFAULT_REFUND_INQUIRY_WINDOW_SECONDS) * 1000;
  const maxAttempts = deps.jobMaxAttempts ?? DEFAULT_REFUND_INQUIRY_JOB_MAX_ATTEMPTS;
  const audit = deps.audit ?? ((input: Parameters<typeof writeSystemAudit>[1]) => writeSystemAudit(deps.db, input));
  let resolution = deps.resolution;
  const resolutionPort = (): RefundResolutionPort => {
    if (!resolution) {
      if (!deps.ledgerPoster || !deps.repositories) {
        throw new ApiError(503, "REFUND_INQUIRY_NOT_CONFIGURED", "The refund inquiry handler needs a ledger poster and repositories");
      }
      resolution = createGovernanceRefundResolution({
        db: deps.db,
        ledgerPoster: deps.ledgerPoster,
        repositories: deps.repositories,
      });
    }
    return resolution;
  };

  return {
    async handle(job: BackgroundJobRow): Promise<void> {
      const payload = parseRefundInquiryPayload(job);
      const adjustment = await adjustments.find(payload.adjustmentId);
      if (!adjustment || adjustment.type !== "REFUND" || adjustment.state !== "EXECUTING") {
        // Settled elsewhere (an operator, a repeated execution) or never a refund.
        logger.info("RefundInquiry: nothing to inquire", {
          adjustmentId: payload.adjustmentId,
          state: adjustment?.state ?? null,
        });
        return;
      }
      const attemptId = adjustment.sourceAttemptId ?? payload.attemptId;
      const now = clock();
      const windowStart = new Date(payload.windowStartedAt);
      const windowEndsAt = windowStart.getTime() + windowMs;

      if (now.getTime() >= windowEndsAt) {
        await cases.open({
          adjustmentId: adjustment.id,
          attemptId,
          now,
          reason: `the gateway gave no definitive answer within the ${Math.round(windowMs / 3_600_000)} h inquiry window (${payload.check} checks)`,
        });
        return;
      }

      let outcome: RefundInquiryOutcome;
      try {
        outcome = await deps.inquiry.inquire({
          adjustmentId: adjustment.id,
          attemptId,
          amount: adjustment.amount,
          check: payload.check,
        });
      } catch (error) {
        outcome = { status: "UNKNOWN", definitive: false, detail: (error as Error).message };
      }

      if (outcome.supported === false) {
        await cases.open({
          adjustmentId: adjustment.id,
          attemptId,
          now,
          reason: outcome.detail ?? "the rail offers no refund inquiry",
        });
        return;
      }

      if (deps.dryRun && outcome.definitive && (outcome.status === "SUCCEEDED" || outcome.status === "FAILED")) {
        const wouldDo = outcome.status === "SUCCEEDED" ? "FINALIZE" : "FAIL";
        await audit({
          action: "REFUND_INQUIRY_DRY_RUN",
          entityType: "ADJUSTMENT",
          entityId: adjustment.id,
          before: { state: "EXECUTING" },
          after: { state: "EXECUTING", wouldDo, gatewayStatus: outcome.status, detail: outcome.detail ?? null, check: payload.check },
        });
        await cases.open({
          adjustmentId: adjustment.id,
          attemptId,
          now,
          reason: `dry run: the gateway answered ${outcome.status}; the automation would ${wouldDo === "FINALIZE" ? "book" : "reject"} the refund`,
        });
        return;
      }

      if (outcome.definitive && outcome.status === "SUCCEEDED") {
        const result = await resolutionPort().finalize({ adjustmentId: adjustment.id, ownershipMode: outcome.ownershipMode });
        logger.info("RefundInquiry: refund confirmed and booked", { adjustmentId: adjustment.id, ...result });
        return;
      }
      if (outcome.definitive && outcome.status === "FAILED") {
        const result = await resolutionPort().fail({
          adjustmentId: adjustment.id,
          reason: outcome.detail ?? "The gateway confirmed that the refund was not performed",
        });
        logger.info("RefundInquiry: refund confirmed as not performed", { adjustmentId: adjustment.id, ...result });
        return;
      }

      const delaySeconds = backoff[Math.min(payload.check, backoff.length - 1)] ?? backoff[backoff.length - 1] ?? 60;
      // The last check runs exactly when the window ends and opens the case.
      const nextAt = new Date(Math.min(now.getTime() + delaySeconds * 1000, windowEndsAt));
      await store.enqueueFollowUp({ ...payload, check: payload.check + 1 }, nextAt, maxAttempts);
      logger.info("RefundInquiry: refund still unresolved, next check scheduled", {
        adjustmentId: adjustment.id,
        check: payload.check + 1,
        nextAt: nextAt.toISOString(),
        detail: outcome.detail ?? null,
      });
    },
  };
};

// ---------------------------------------------------------------------------
// Monitor helper
// ---------------------------------------------------------------------------

export interface UnscheduledExecutingRefund {
  adjustmentId: string;
  sourceAttemptId: string | null;
  amount: string;
  updatedAt: Date;
}

/**
 * EXECUTING refunds older than N minutes that neither a live inquiry job nor
 * an unresolved inquiry case covers: what a lost `schedule` call (or a crash
 * between the gateway call and the scheduling) leaves behind. For the platform
 * monitor; re-scheduling them is `scheduler.schedule(sourceAttemptId, adjustmentId)`.
 */
export const findExecutingRefundsWithoutInquiry = async (
  db: PrismaLike,
  options: { olderThanMinutes?: number; limit?: number; now?: Date } = {},
): Promise<UnscheduledExecutingRefund[]> => {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.olderThanMinutes ?? 15) * 60_000);
  const rows = toCamelRows<{ id: string; sourceAttemptId: string | null; amount: unknown; updatedAt: Date | string }>(
    await db.$queryRawUnsafe(
      "SELECT a.id, a.source_attempt_id, a.amount::text AS amount, a.updated_at FROM adjustments a"
        + " WHERE a.type = 'REFUND' AND a.state = 'EXECUTING' AND a.updated_at <= $1"
        + " AND NOT EXISTS (SELECT 1 FROM background_jobs j WHERE j.job_type::text = 'REFUND_INQUIRY'"
        + " AND j.reference_type = 'ADJUSTMENT' AND j.reference_id = a.id::text AND j.state IN ('QUEUED', 'RUNNING'))"
        + " AND NOT EXISTS (SELECT 1 FROM operator_cases c WHERE c.subject_key = 'refund.inquiry:' || a.id::text"
        + " AND c.state <> 'RESOLVED')"
        + " ORDER BY a.updated_at ASC LIMIT $2",
      cutoff,
      Math.max(1, Math.floor(options.limit ?? 50)),
    ),
  );
  return rows.map((row) => ({
    adjustmentId: String(row.id),
    sourceAttemptId: row.sourceAttemptId ? String(row.sourceAttemptId) : null,
    amount: String(row.amount),
    updatedAt: new Date(row.updatedAt),
  }));
};
