import { Decimal } from "decimal.js";
import type { PrismaLike } from "../db/ports";
import { env } from "../../lib/env";
import { getPlatformRuntime } from "../runtime";
import type { InquiryOutcome, InquiryPort } from "./ExpirySweeperWorker";
import type { InboundEventHandler } from "./InboundInboxWorker";
import type { NotificationSender } from "./OutboxNotificationWorker";
import { ExpirySweeperWorker } from "./ExpirySweeperWorker";
import { PollWorker } from "./PollWorker";
import { InboundInboxWorker } from "./InboundInboxWorker";
import { OutboxNotificationWorker } from "./OutboxNotificationWorker";
import { LedgerCheckpointWorker } from "./LedgerCheckpointWorker";
import { LedgerShardScalerWorker } from "./LedgerShardScalerWorker";
import { LedgerInvariantWorker } from "./LedgerInvariantWorker";
import { JoinRequestExpiryWorker } from "./JoinRequestExpiryWorker";
import { PeriodicScreeningWorker } from "./PeriodicScreeningWorker";
import { KybExpiryWorker } from "./KybExpiryWorker";
import { RetentionWorker } from "./RetentionWorker";
import { BackgroundJobWorker } from "./BackgroundJobWorker";
import { PlatformMonitorWorker } from "./PlatformMonitorWorker";
import { createStandardPlatformChecks, type CertificateFile } from "./platformMonitorChecks";
import { createStaleUnknownMonitorCheck, createUnscheduledRefundMonitorCheck } from "./moneyPathMonitorChecks";
import { createBackupMonitorCheck } from "./backupMonitorChecks";
import { getBackupControlClient } from "../../lib/storageEngine/backupControlClient";
import { CommissionNettingWorker } from "./CommissionNettingWorker";
import { JournalPartitionWorker } from "./JournalPartitionWorker";
import { ExpiryHousekeepingWorker } from "./ExpiryHousekeepingWorker";
import { DeadlineWorker } from "./DeadlineWorker";
import { ExpiryNoticeWorker } from "./ExpiryNoticeWorker";
import { KybScanWorker } from "./KybScanWorker";
import { AuditChainAnchorWorker } from "./AuditChainAnchorWorker";
import { RegulatoryReportWorker } from "./RegulatoryReportWorker";
import { MerchantWebhookWorker } from "./MerchantWebhookWorker";
import { StatementScheduleWorker } from "./StatementScheduleWorker";
import { ConsistencyAuditWorker } from "./ConsistencyAuditWorker";
import { createWebhookFanout } from "../webhooks/fanout";
import { VaultContextCipher } from "../runtime/contextCipher";
import { createKybScanner } from "../../lib/kybScanner";
import { ReportGenerationService } from "../compliance/reporting/ReportGenerationService";
import { createObjectStorageSdk, type ObjectStorageSdk } from "../../lib/objectStorageSdk";
import { ObjectStorageMaintenanceWorker } from "./ObjectStorageWorkers";
import { createObjectStorageMonitorCheck } from "./objectStorageMonitorChecks";
import { createEngineRefundInquiryPort, createRefundInquiryJobHandler } from "./RefundInquiry";
import type { StorageEngine } from "../../lib/storageEngine/ports";
import {
  AuditShipperWorker,
  OutboxRelayWorker,
} from "../../lib/storageEngine/outboxWorkers";
import { DedicatedAuditDatabaseDriver } from "../../lib/storageEngine/auditAndLogAdapters";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  createAdjustmentJobHandler,
  createFeeVariancePoster,
  createReconciliationJobHandler,
} from "./BackgroundJobHandlers";
import { PrismaRepositories } from "../db/repositories";
import { toCamelRows } from "../db/rawRows";
import { Vault } from "../crypto/Vault";
import {
  createNotificationTransport,
  type NotificationRecipientResolver,
  type NotificationTransport,
} from "../notifications/NotificationTransport";

export interface ProductionWorkerRuntimeOptions {
  db: PrismaLike;
  /** Ledger checkpoint worker (per-shard, verified, lock-free). Each falls back to its env key. */
  ledgerCheckpointEnabled?: boolean;
  ledgerCheckpointIntervalMs?: number;
  ledgerCheckpointBatchSize?: number;
  ledgerCheckpointMinLines?: number;
  ledgerCheckpointMaxAgeMs?: number;
  ledgerShardAutoRepairEnabled?: boolean;
  ledgerShardAutoRepairMinFailures?: number;
  ledgerShardAutoRepairMaxAbsDrift?: number;
  /** Ledger shard scaler (dry run by default). Each falls back to its env key. */
  ledgerShardScalerEnabled?: boolean;
  ledgerShardScalerIntervalMs?: number;
  ledgerShardScalerDryRun?: boolean;
  ledgerShardUpLinesPerSec?: number;
  ledgerShardMaxWidth?: number;
  ledgerShardCooldownMs?: number;
  intervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  notificationTransportUrl?: string;
  notificationTransportTimeoutMs?: number;
  notificationTransport?: NotificationTransport;
  /**
   * How long a merchant stays screened before the periodic re-screening
   * picks it up again.
   */
  rescreenIntervalMs?: number;
  /**
   * How often the KYB expiry and periodic re-verification worker runs.
   */
  kybExpiryIntervalMs?: number;
  /**
   * How many KYB rows the worker checks in one pass.
   */
  kybExpiryBatchSize?: number;
  /**
   * The record retention worker (OD-4). It is off unless the deployment
   * turns it on, because it removes evidence.
   */
  retentionEnabled?: boolean;
  /**
   * How often the retention worker runs.
   */
  retentionIntervalMs?: number;
  /**
   * How many rows the retention worker purges in one batch.
   */
  retentionBatchSize?: number;
  /**
   * The retention period in days. Without it the period comes from the
   * platform setting `OD-4`.
   */
  retentionDays?: number;
  /**
   * The dry run of the retention worker: it reports what it would purge
   * without deleting anything.
   */
  retentionDryRun?: boolean;
  /**
   * The durable job queue worker. It drains the background jobs (the
   * statement reconciliation and the dispute / adjustment execution).
   */
  backgroundJobsEnabled?: boolean;
  /**
   * How often the background job queue is drained.
   */
  backgroundJobsIntervalMs?: number;
  /**
   * How many background jobs are claimed in one drain.
   */
  backgroundJobsBatchSize?: number;
  /**
   * The lease of a claimed background job: a job that is still `RUNNING`
   * when its lease expired belongs to a crashed node and is re-queued.
   */
  backgroundJobsLeaseSeconds?: number;
  /** The platform monitor (AUTO-03). Falls back to `WORKER_PLATFORM_MONITOR_ENABLED`. */
  platformMonitorEnabled?: boolean;
  platformMonitorIntervalMs?: number;
  /** Statement schedule alerts (AUTO-07) and the slot consistency audit (AUTO-12). Fall back to their env keys. */
  statementScheduleEnabled?: boolean;
  consistencyAuditEnabled?: boolean;
  /** Outbound merchant webhooks (AUTO-34). Fall back to their env keys. */
  merchantWebhookEnabled?: boolean;
  merchantWebhookIntervalMs?: number;
  /** Overrides the HTTP sender (tests). */
  merchantWebhookSend?: ConstructorParameters<typeof MerchantWebhookWorker>[0]["send"];
  /** Regulatory report drafting (AUTO-16). Falls back to its env keys. */
  regulatoryReportEnabled?: boolean;
  regulatoryReportIntervalMs?: number;
  /** Daily audit-chain anchor (AUTO-27). Falls back to its env keys; needs the dedicated audit database. */
  auditAnchorEnabled?: boolean;
  auditAnchorIntervalMs?: number;
  /** KYB document scanning (AUTO-06). Fall back to their env keys. */
  kybScanEnabled?: boolean;
  kybScanIntervalMs?: number;
  kybScanBatchSize?: number;
  /** Overrides the scanner `KYB_SCANNER_MODE` selects (tests inject a fake). */
  kybScanner?: import("../../lib/kybScanner").KybScanner | null;
  /** Shared object storage housekeeping (staging GC, orphan sweep, integrity scrub, lock reconcile, AV fallback). */
  objectStorageEnabled?: boolean;
  objectStorageIntervalMs?: number;
  objectStorageBatchSize?: number;
  /** Overrides the SDK (tests inject one bound to a sandbox database). */
  objectStorageSdk?: ObjectStorageSdk;
  /** Merchant-direct commission netting (AUTO-21). Fall back to their env keys. */
  commissionNettingEnabled?: boolean;
  commissionNettingIntervalMs?: number;
  commissionNettingDryRun?: boolean;
  commissionNettingCron?: string;
  commissionReceivableAgingDays?: number;
  /** Journal partition maintenance (AUTO-01). Fall back to their env keys. */
  journalPartitionEnabled?: boolean;
  journalPartitionIntervalMs?: number;
  journalPartitionMonthsAhead?: number;
  /** Token and credential expiry notices and credential re-verification (AUTO-08, AUTO-26). Fall back to their env keys. */
  expiryNoticeEnabled?: boolean;
  expiryNoticeIntervalMs?: number;
  credentialReverifyDryRun?: boolean;
  /** SLA and deadline escalation (AUTO-04, AUTO-22). Fall back to their env keys. */
  deadlineEnabled?: boolean;
  deadlineIntervalMs?: number;
  deadlineBatchSize?: number;
  /** Expiry housekeeping (AUTO-05, AUTO-11). Fall back to their env keys. */
  expiryHousekeepingEnabled?: boolean;
  expiryHousekeepingIntervalMs?: number;
  expiryHousekeepingBatchSize?: number;
  /** Refund inquiry (AUTO-20) dry run. Falls back to `REFUND_INQUIRY_DRY_RUN`. */
  refundInquiryDryRun?: boolean;
  /** Optional storage engine; when present its CQRS/audit shippers run. */
  storage?: StorageEngine;
}

export interface ProductionWorkerRuntime {
  workers: Array<{ start: () => void; stop: () => void; readonly isRunning: boolean }>;
  start: () => void;
  stop: () => void;
}

/**
 * The gating of the durable queue.
 *
 * The statement upload and the dispute intake answer `202 Accepted` and only
 * enqueue a job, so the API must never boot without a worker that drains it.
 */
export interface BackgroundJobGating {
  workerEnabled: boolean;
  backgroundJobsEnabled: boolean;
}

export const assertBackgroundJobQueueDrainable = (gating: BackgroundJobGating): void => {
  if (!gating.workerEnabled) {
    throw new Error(
      "Refusing to start core-back: WORKER_ENABLED is disabled while the statement " +
        "upload and the dispute intake are queue-only routes (202 Accepted). " +
        "Enable WORKER_ENABLED or jobs will be accepted and never executed.",
    );
  }
  if (!gating.backgroundJobsEnabled) {
    throw new Error(
      "Refusing to start core-back: WORKER_BACKGROUND_JOBS_ENABLED is disabled while " +
        "the statement upload and the dispute intake are queue-only routes (202 Accepted). " +
        "Every queued job would be stranded without a drain.",
    );
  }
};

/** The default age of the oldest queued job that the health probe tolerates. */
export const DEFAULT_QUEUE_AGE_THRESHOLD_MS = 300_000;

export interface BackgroundJobQueueHealth {
  queued: number;
  oldestQueuedAgeMs: number | null;
  thresholdMs: number;
  degraded: boolean;
}

export interface QueueHealthDatabase {
  backgroundJob: {
    count: (args: { where: { state: string } }) => Promise<number>;
    findFirst: (args: {
      where: { state: string };
      orderBy: { createdAt: "asc" };
      select: { createdAt: true };
    }) => Promise<{ createdAt: Date | string | null } | null>;
  };
}

const ageOf = (createdAt: Date | string | null, now: Date): number | null => {
  if (createdAt === null) {
    return null;
  }
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) {
    return null;
  }
  return Math.max(0, now.getTime() - created.getTime());
};

/**
 * Reads the queue health without leaking tenant data: the count and the age
 * of the oldest `QUEUED` job are enough to tell that the drain is stuck.
 */
export const readBackgroundJobQueueHealth = async (
  db: QueueHealthDatabase,
  options: { now?: Date; thresholdMs?: number } = {},
): Promise<BackgroundJobQueueHealth> => {
  const now = options.now ?? new Date();
  const thresholdMs = options.thresholdMs ?? DEFAULT_QUEUE_AGE_THRESHOLD_MS;
  const [queued, oldest] = await Promise.all([
    db.backgroundJob.count({ where: { state: "QUEUED" } }),
    db.backgroundJob.findFirst({
      where: { state: "QUEUED" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);
  const oldestQueuedAgeMs = ageOf(oldest?.createdAt ?? null, now);
  return {
    queued,
    oldestQueuedAgeMs,
    thresholdMs,
    degraded: oldestQueuedAgeMs !== null && oldestQueuedAgeMs > thresholdMs,
  };
};

/** `72,24` -> [72, 24]; a malformed list falls back to the default. */
export const parseHourList = (value: string, fallback: readonly number[]): number[] => {
  const hours = value.split(",").map((part) => Number(part.trim())).filter((hour) => Number.isFinite(hour) && hour > 0);
  return hours.length > 0 ? hours : [...fallback];
};

/** `label=path,label=path` -> certificate files; the mTLS and backup-client paths when the list is empty. */
export const resolveCertificateFiles = (): CertificateFile[] => {
  const configured = env.PLATFORM_MONITOR_CERT_FILES.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry): CertificateFile[] => {
      const index = entry.indexOf("=");
      const label = (index > 0 ? entry.slice(0, index) : entry).trim().replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 48);
      const path = (index > 0 ? entry.slice(index + 1) : entry).trim();
      return label && path ? [{ label, path }] : [];
    });
  if (configured.length > 0) return configured;
  return [
    { label: "mtls_ca", path: env.MTLS_CA_CERT_PATH },
    { label: "mtls_server", path: env.MTLS_SERVER_CERT_PATH },
    ...(env.BACKUP_DAEMON_CLIENT_CERT_PATH ? [{ label: "backup_client", path: env.BACKUP_DAEMON_CLIENT_CERT_PATH }] : []),
  ];
};

/**
 * Builds the durable workers of `core-back` with every port connected to a
 * real implementation:
 *
 *  - `inquiry`     -> the universal rail engine (`inquire`), so an expiring
 *                     attempt is always ASKED before it is expired;
 *  - `handler`     -> the engine's callback verification, so the webhook inbox
 *                     is actually drained;
 *  - `sender`      -> the notification transport.
 */
export const createProductionWorkerRuntime = (
  options: ProductionWorkerRuntimeOptions,
): ProductionWorkerRuntime => {
  const platform = getPlatformRuntime(options.db);
  const repositories = new PrismaRepositories(options.db);

  const inquiry: InquiryPort = {
    inquire: async (attempt): Promise<InquiryOutcome> => {
      const result = await platform.engine.inquire(attempt as never);
      return {
        status: result.status,
        definitive: result.status === "SUCCEEDED" || result.status === "FAILED",
        settledAmount: result.attempt.settledAmount,
        providerFee: result.attempt.gatewayFeeAmount,
      };
    },
  };

  const handler: InboundEventHandler = {
    handle: async (event) => {
      const rawBody = toBuffer(event.rawBodyBytes);
      const channel = await options.db.confirmationChannel.findUnique({
        where: { id: event.channelId },
      });
      if (!channel) {
        return { processed: false, result: "CHANNEL_UNKNOWN" };
      }
      const headers = ((event.redactedHeadersJson ?? {}) as Record<string, string>);
      try {
        const result = await platform.engine.verifyCallback(channel.pathToken, {
          rawBody,
          headers,
          sourceIp: event.sourceIp,
        });
        return { processed: true, result: result.status };
      } catch (error) {
        return {
          processed: false,
          result: String((error as { code?: string })?.code ?? "CALLBACK_VERIFICATION_FAILED"),
        };
      }
    },
  };

  const transport = resolveNotificationTransport(options);

  const sender: NotificationSender = {
    send: async (notification, rendered) => {
      const result = await transport.deliver(notification, rendered);
      return {
        status: result.status,
        providerMessageId: result.providerMessageId ?? null,
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },
  };

  const workerOptions = {
    db: options.db,
    repositories,
    intervalMs: options.intervalMs,
    batchSize: options.batchSize,
    // Singleton workers only tick on the advisory-lock leader (GAP-012).
    leaderElection: options.storage?.leaderElection,
  };

  const objectStorageEnabled = options.objectStorageEnabled ?? env.WORKER_OBJECT_STORAGE_ENABLED;
  const platformMonitorEnabled = options.platformMonitorEnabled ?? env.WORKER_PLATFORM_MONITOR_ENABLED;
  const objectStorageSdk: ObjectStorageSdk =
    options.objectStorageSdk ?? createObjectStorageSdk({ prisma: options.db as unknown as PrismaClient });

  const workers = [
    new ExpirySweeperWorker({ ...workerOptions, inquiry }),
    new PollWorker({ ...workerOptions, inquiry, unknownCaseSlaHours: env.UNKNOWN_ATTEMPT_CASE_SLA_HOURS }),
    new InboundInboxWorker({ ...workerOptions, handler, maxAttempts: options.maxAttempts }),
    new OutboxNotificationWorker({ ...workerOptions, sender }),
    new LedgerInvariantWorker(workerOptions),
    // Per-shard ledger checkpoints: verified, O(delta), lock-free (idempotent, so safe to run anywhere).
    ...((options.ledgerCheckpointEnabled ?? env.WORKER_LEDGER_CHECKPOINT_ENABLED)
      ? [
          new LedgerCheckpointWorker({
            ...workerOptions,
            intervalMs: options.ledgerCheckpointIntervalMs ?? env.WORKER_LEDGER_CHECKPOINT_INTERVAL_MS,
            batchSize: options.ledgerCheckpointBatchSize ?? env.WORKER_LEDGER_CHECKPOINT_BATCH_SIZE,
            minLines: options.ledgerCheckpointMinLines ?? env.LEDGER_CHECKPOINT_MIN_LINES,
            maxAgeMs: options.ledgerCheckpointMaxAgeMs ?? env.LEDGER_CHECKPOINT_MAX_AGE_MS,
            autoRepair: {
              enabled: options.ledgerShardAutoRepairEnabled ?? env.LEDGER_SHARD_AUTO_REPAIR_ENABLED,
              minConsecutiveFailures: options.ledgerShardAutoRepairMinFailures ?? env.LEDGER_SHARD_AUTO_REPAIR_MIN_FAILURES,
              maxAbsDelta: new Decimal(options.ledgerShardAutoRepairMaxAbsDrift ?? env.LEDGER_SHARD_AUTO_REPAIR_MAX_ABS_DRIFT),
            },
          }),
        ]
      : []),
    // Hot-account detection: widens a GL account that keeps one shard saturated (dry run until calibrated).
    ...((options.ledgerShardScalerEnabled ?? env.WORKER_LEDGER_SHARD_SCALER_ENABLED)
      ? [
          new LedgerShardScalerWorker({
            ...workerOptions,
            intervalMs: options.ledgerShardScalerIntervalMs ?? env.WORKER_LEDGER_SHARD_SCALER_INTERVAL_MS,
            dryRun: options.ledgerShardScalerDryRun ?? env.LEDGER_SHARD_SCALER_DRY_RUN,
            config: {
              upLinesPerSec: options.ledgerShardUpLinesPerSec ?? env.LEDGER_SHARD_UP_LINES_PER_SEC,
              maxWidth: options.ledgerShardMaxWidth ?? env.LEDGER_SHARD_MAX_WIDTH,
              cooldownMs: options.ledgerShardCooldownMs ?? env.LEDGER_SHARD_COOLDOWN_MS,
            },
          }),
        ]
      : []),
    // The onboarding drafts that are abandoned, and the review requests whose
    // SLA elapsed, are expired instead of sitting open forever (design §18).
    new JoinRequestExpiryWorker(workerOptions),
    // The ongoing screening layer (L2) re-screens the active merchants
    // against the watch list and raises a case for a merchant that became a
    // confirmed match after its onboarding.
    new PeriodicScreeningWorker({
      ...workerOptions,
      screening: platform.screening,
      rescreenIntervalMs: options.rescreenIntervalMs,
    }),
    // The KYB lifecycle: expiry, notices, automatic suspension and periodic
    // re-verification requests (design §16.4 and §16.10).
    new KybExpiryWorker({
      ...workerOptions,
      intervalMs: options.kybExpiryIntervalMs ?? env.WORKER_KYB_EXPIRY_INTERVAL_MS,
      batchSize: options.kybExpiryBatchSize ?? env.WORKER_KYB_EXPIRY_BATCH_SIZE,
    }),
    // The record retention worker (OD-4) removes the regulatory evidence
    // that passed the retention period. It only runs when the deployment
    // turns it on, and it can run as a dry run.
    ...((options.retentionEnabled ?? env.WORKER_RETENTION_ENABLED)
      ? [
          new RetentionWorker({
            ...workerOptions,
            intervalMs: options.retentionIntervalMs ?? env.WORKER_RETENTION_INTERVAL_MS,
            batchSize: options.retentionBatchSize ?? env.WORKER_RETENTION_BATCH_SIZE,
            retentionDays: options.retentionDays,
            dryRun: options.retentionDryRun ?? env.RETENTION_DRY_RUN,
          }),
        ]
      : []),
    // The transactional outbox projector maintains the CQRS read models.
    ...(options.storage
      ? [
          new OutboxRelayWorker(options.db as unknown as PrismaClient, {
            intervalMs: 250,
            maxIdleIntervalMs: 2_000,
            batchSize: Math.max(50, (options.batchSize ?? 50) * 2),
            retention: { retentionMs: env.STORAGE_OUTBOX_RETENTION_MS },
            deadLetter: { maxAttempts: env.OUTBOX_MAX_ATTEMPTS },
            // AUTO-34: merchant-facing events become webhook deliveries in the relay's own transaction.
            ...((options.merchantWebhookEnabled ?? env.WORKER_MERCHANT_WEBHOOK_ENABLED)
              ? {
                  fanout: Object.fromEntries(
                    ["attempt.transitioned", "link.expired", "dispute.opened", "dispute.closed", "cashout.paid", "cashout.failed"].map((topic) => [topic, createWebhookFanout() as never]),
                  ),
                }
              : {}),
          }),
          ...(options.storage.auditStore instanceof DedicatedAuditDatabaseDriver
            ? [
                new AuditShipperWorker(
                  options.db as unknown as PrismaClient,
                  options.storage.auditStore,
                  {
                    intervalMs: 500,
                    maxIdleIntervalMs: 5_000,
                    batchSize: Math.max(50, (options.batchSize ?? 50) * 2),
                    retention: { retentionMs: env.STORAGE_AUDIT_OUTBOX_RETENTION_MS },
                  },
                ),
              ]
            : []),
        ]
      : []),
    // The durable job queue: the statement reconciliation and the dispute /
    // adjustment execution are executed by a stateless worker that claims
    // the due jobs with `FOR UPDATE SKIP LOCKED`.
    ...((options.backgroundJobsEnabled ?? env.WORKER_BACKGROUND_JOBS_ENABLED)
      ? [
          new BackgroundJobWorker({
            ...workerOptions,
            intervalMs: options.backgroundJobsIntervalMs ?? env.WORKER_BACKGROUND_JOBS_INTERVAL_MS,
            batchSize: options.backgroundJobsBatchSize ?? env.WORKER_BACKGROUND_JOBS_BATCH_SIZE,
            leaseSeconds: options.backgroundJobsLeaseSeconds ?? env.WORKER_BACKGROUND_JOBS_LEASE_SECONDS,
            handlers: {
              RECONCILIATION_RUN: createReconciliationJobHandler({
                db: options.db,
                repositories,
                feeVariancePoster: createFeeVariancePoster(platform.ledgerPoster),
              }),
              ADJUSTMENT_EXECUTION: createAdjustmentJobHandler({
                db: options.db,
                ledgerPoster: platform.ledgerPoster,
                repositories,
                // AUTO-20: a refund the gateway answered UNKNOWN stays EXECUTING and is asked about again.
                reconciliationScheduler: platform.refundScheduler,
              }),
              // AUTO-20: one gateway inquiry per job, with backoff, until the refund is booked, rejected or an operator takes over.
              REFUND_INQUIRY: createRefundInquiryJobHandler({
                db: options.db,
                inquiry: createEngineRefundInquiryPort({ db: options.db, engine: platform.engine }),
                ledgerPoster: platform.ledgerPoster,
                repositories,
                dryRun: options.refundInquiryDryRun ?? env.REFUND_INQUIRY_DRY_RUN,
                windowSeconds: env.REFUND_INQUIRY_WINDOW_SECONDS,
              }),
            },
          }),
        ]
      : []),
    // AUTO-01: keeps the next monthly journal partitions in existence (the cron's function) and alarms on stranded rows.
    ...((options.journalPartitionEnabled ?? env.WORKER_JOURNAL_PARTITION_ENABLED)
      ? [
          new JournalPartitionWorker({
            ...workerOptions,
            intervalMs: options.journalPartitionIntervalMs ?? env.WORKER_JOURNAL_PARTITION_INTERVAL_MS,
            batchSize: undefined,
            monthsAhead: options.journalPartitionMonthsAhead ?? env.LEDGER_PARTITION_MONTHS_AHEAD,
          }),
        ]
      : []),
    // AUTO-08 / AUTO-26: token and credential expiry notices, expired credentials taken out of use, scheduled re-verification.
    ...((options.expiryNoticeEnabled ?? env.WORKER_EXPIRY_NOTICE_ENABLED)
      ? [
          new ExpiryNoticeWorker({
            ...workerOptions,
            intervalMs: options.expiryNoticeIntervalMs ?? env.WORKER_EXPIRY_NOTICE_INTERVAL_MS,
            batchSize: undefined,
            tokenNoticeDays: parseHourList(env.TOKEN_EXPIRY_NOTICE_DAYS, [30, 7, 1]),
            credentialNoticeDays: parseHourList(env.CREDENTIAL_EXPIRY_NOTICE_DAYS, [30, 7, 1]),
            credentialCaseDays: env.CREDENTIAL_EXPIRY_CASE_DAYS,
            catchupHours: env.DEADLINE_CATCHUP_HOURS,
            caseSlaHours: env.DEADLINE_CASE_SLA_HOURS,
            reverifyAfterHours: env.CREDENTIAL_REVERIFY_AFTER_HOURS,
            reverifyBatchSize: env.CREDENTIAL_REVERIFY_BATCH_SIZE,
            reverifyDryRun: options.credentialReverifyDryRun ?? env.CREDENTIAL_REVERIFY_DRY_RUN,
            verifier: {
              verify: async (credentialSetId) => {
                const result = (await platform.credentialCheck.verify(credentialSetId)) as { status?: string; reason?: string };
                return { status: String(result.status ?? "UNKNOWN"), reason: result.reason };
              },
            },
          }),
        ]
      : []),
    // AUTO-04 / AUTO-22: reminders, escalations and deadline outcomes (cases, disputes, cash-outs, emergency actions).
    ...((options.deadlineEnabled ?? env.WORKER_DEADLINE_ENABLED)
      ? [
          new DeadlineWorker({
            ...workerOptions,
            intervalMs: options.deadlineIntervalMs ?? env.WORKER_DEADLINE_INTERVAL_MS,
            batchSize: options.deadlineBatchSize ?? env.WORKER_DEADLINE_BATCH_SIZE,
            caseReminderLeadMs: env.DEADLINE_CASE_REMINDER_LEAD_MINUTES * 60_000,
            joinReminderLeadMs: env.DEADLINE_JOIN_REMINDER_LEAD_HOURS * 3_600_000,
            catchupHours: env.DEADLINE_CATCHUP_HOURS,
            caseSlaHours: env.DEADLINE_CASE_SLA_HOURS,
            disputeReminderHours: parseHourList(env.DISPUTE_REMINDER_HOURS, [72, 24]),
            disputeRulingSlaDays: env.DISPUTE_RULING_SLA_DAYS,
            cashoutSlaBusinessHours: env.CASHOUT_SLA_BUSINESS_HOURS,
            cashoutReminderRatio: env.CASHOUT_SLA_REMINDER_RATIO,
            emergencyGraceHours: env.EMERGENCY_RATIFICATION_GRACE_HOURS,
            emergencyEscalateEveryHours: env.EMERGENCY_ESCALATE_EVERY_HOURS,
            emergencyReminderHours: parseHourList(env.EMERGENCY_REMINDER_HOURS, [4, 1]),
            reportReminderBusinessDays: env.REGULATORY_REPORT_REMINDER_BUSINESS_DAYS,
          }),
        ]
      : []),
    // AUTO-05 / AUTO-11: closes approvals nobody decided, expired invitations, links and old MFA / revocation rows.
    ...((options.expiryHousekeepingEnabled ?? env.WORKER_EXPIRY_HOUSEKEEPING_ENABLED)
      ? [
          new ExpiryHousekeepingWorker({
            ...workerOptions,
            intervalMs: options.expiryHousekeepingIntervalMs ?? env.WORKER_EXPIRY_HOUSEKEEPING_INTERVAL_MS,
            batchSize: options.expiryHousekeepingBatchSize ?? env.WORKER_EXPIRY_HOUSEKEEPING_BATCH_SIZE,
            mfaRetentionHours: env.MFA_CHALLENGE_RETENTION_HOURS,
            secretScrubAfterMinutes: env.NOTIFICATION_SECRET_SCRUB_AFTER_MINUTES,
          }),
        ]
      : []),
    // AUTO-07: raises a keyed case for every scheduled statement that did not arrive (and resolves it when it does).
    ...((options.statementScheduleEnabled ?? env.WORKER_STATEMENT_SCHEDULE_ENABLED)
      ? [
          new StatementScheduleWorker({
            ...workerOptions,
            intervalMs: env.WORKER_STATEMENT_SCHEDULE_INTERVAL_MS,
            batchSize: undefined,
            graceMinutes: env.STATEMENT_SCHEDULE_GRACE_MINUTES,
            lookbackSlots: env.STATEMENT_SCHEDULE_LOOKBACK_SLOTS,
          }),
        ]
      : []),
    // AUTO-12: compares payment-link slot counters with the live attempts (report only unless repair is switched on).
    ...((options.consistencyAuditEnabled ?? env.WORKER_CONSISTENCY_AUDIT_ENABLED)
      ? [
          new ConsistencyAuditWorker({
            ...workerOptions,
            intervalMs: env.WORKER_CONSISTENCY_AUDIT_INTERVAL_MS,
            batchSize: undefined,
            repair: env.CONSISTENCY_AUDIT_REPAIR,
          }),
        ]
      : []),
    // AUTO-34: delivers the merchant webhooks (signed, egress-safe, exponential backoff, parked after the last attempt).
    ...((options.merchantWebhookEnabled ?? env.WORKER_MERCHANT_WEBHOOK_ENABLED)
      ? [
          new MerchantWebhookWorker({
            ...workerOptions,
            intervalMs: options.merchantWebhookIntervalMs ?? env.WORKER_MERCHANT_WEBHOOK_INTERVAL_MS,
            batchSize: env.WORKER_MERCHANT_WEBHOOK_BATCH_SIZE,
            openSecret: async (ciphertext) => {
              automationVault ??= new Vault();
              return automationVault.decryptSecret(ciphertext);
            },
            send: options.merchantWebhookSend,
            allowInsecure: env.MERCHANT_WEBHOOK_ALLOW_INSECURE,
            timeoutMs: env.MERCHANT_WEBHOOK_TIMEOUT_MS,
            concurrency: env.MERCHANT_WEBHOOK_CONCURRENCY,
            disableAfterMs: env.MERCHANT_WEBHOOK_DISABLE_AFTER_DAYS * 86_400_000,
          }),
        ]
      : []),
    // AUTO-16: drafts the scheduled regulatory returns (PSP-M, AML-Q, AML-A) and the business-day large-transaction batch,
    // encrypted like the other report payloads. DRAFT only: filing stays with the MLRO.
    ...((options.regulatoryReportEnabled ?? env.WORKER_REGULATORY_REPORT_ENABLED)
      ? [
          new RegulatoryReportWorker({
            ...workerOptions,
            intervalMs: options.regulatoryReportIntervalMs ?? env.WORKER_REGULATORY_REPORT_INTERVAL_MS,
            batchSize: undefined,
            encode: async (plaintext) => {
              automationVault ??= new Vault();
              return new VaultContextCipher(automationVault, "reporting-payload").encrypt(plaintext);
            },
            maxPeriods: env.REGULATORY_REPORT_MAX_PERIODS,
            maxBatchLines: env.REGULATORY_REPORT_MAX_BATCH_LINES,
            generation: new ReportGenerationService(undefined, objectStorageSdk),
          }),
        ]
      : []),
    // AUTO-27: verifies the live audit hash chain every day and stores a signed anchor in the core database. Only a
    // deployment with the dedicated (append-only, hash-chained) audit database has a chain to verify.
    ...((options.auditAnchorEnabled ?? env.WORKER_AUDIT_ANCHOR_ENABLED) && options.storage?.auditStore instanceof DedicatedAuditDatabaseDriver
      ? [
          new AuditChainAnchorWorker({
            ...workerOptions,
            intervalMs: options.auditAnchorIntervalMs ?? env.WORKER_AUDIT_ANCHOR_INTERVAL_MS,
            batchSize: undefined,
            source: options.storage.auditStore,
            signer: (automationVault ??= new Vault()),
            keyId: env.AUDIT_ANCHOR_KEY_ID,
            segmentRows: env.AUDIT_ANCHOR_SEGMENT_ROWS,
            maxSegmentsPerTick: env.AUDIT_ANCHOR_MAX_SEGMENTS_PER_TICK,
          }),
        ]
      : []),
    // AUTO-06: scans PENDING KYB documents (ClamAV clamd) and re-scans CLEAN ones. Fail closed: a scanner error never
    // marks a document CLEAN. Without a configured scanner the worker is idle and documents stay PENDING.
    ...((options.kybScanEnabled ?? env.WORKER_KYB_SCAN_ENABLED)
      ? [
          new KybScanWorker({
            ...workerOptions,
            intervalMs: options.kybScanIntervalMs ?? env.WORKER_KYB_SCAN_INTERVAL_MS,
            batchSize: options.kybScanBatchSize ?? env.WORKER_KYB_SCAN_BATCH_SIZE,
            objectStorage: objectStorageSdk,
            scanner:
              options.kybScanner !== undefined
                ? options.kybScanner
                : createKybScanner({ mode: env.KYB_SCANNER_MODE, clamdAddress: env.KYB_CLAMD_ADDRESS, timeoutMs: env.KYB_CLAMD_TIMEOUT_MS }),
            openContent: async (ciphertext) => {
              automationVault ??= new Vault();
              return Buffer.from(await automationVault.decryptSecret(ciphertext), "base64");
            },
            // The built-in gate is the upload-time content check; a periodic re-scan against it finds nothing new.
            rescanDays: env.KYB_SCANNER_MODE === "clamd" || options.kybScanner ? env.KYB_RESCAN_DAYS : 0,
            maxAttempts: env.KYB_SCAN_MAX_ATTEMPTS,
          }),
        ]
      : []),
    // Shared object storage housekeeping: AV fallback, staging GC, orphan sweep, scrub, lock reconcile and KEK rewrap.
    ...(objectStorageEnabled
      ? [
          new ObjectStorageMaintenanceWorker({
            ...workerOptions,
            intervalMs: options.objectStorageIntervalMs ?? env.WORKER_OBJECT_STORAGE_INTERVAL_MS,
            batchSize: options.objectStorageBatchSize ?? env.WORKER_OBJECT_STORAGE_BATCH_SIZE,
            sdk: objectStorageSdk,
            prisma: options.db as unknown as PrismaClient,
          }),
        ]
      : []),
    // AUTO-21: daily merchant-direct commission netting after the Tripoli day close (a dry run until the owner turns it live).
    ...((options.commissionNettingEnabled ?? env.WORKER_COMMISSION_NETTING_ENABLED)
      ? [
          new CommissionNettingWorker({
            ...workerOptions,
            intervalMs: options.commissionNettingIntervalMs ?? env.WORKER_COMMISSION_NETTING_INTERVAL_MS,
            batchSize: undefined,
            ledgerPoster: platform.ledgerPoster,
            dryRun: options.commissionNettingDryRun ?? env.COMMISSION_NETTING_DRY_RUN,
            dailyCron: options.commissionNettingCron ?? env.COMMISSION_NETTING_CRON,
            agingDays: options.commissionReceivableAgingDays ?? env.COMMISSION_RECEIVABLE_AGING_DAYS,
          }),
        ]
      : []),
    // AUTO-03: the platform monitor turns worker, queue, checkpoint, certificate and money-path conditions into ONE keyed
    // operator case each. It reads the worker health every other worker reports to the process-wide registry.
    ...((options.platformMonitorEnabled ?? env.WORKER_PLATFORM_MONITOR_ENABLED)
      ? [
          new PlatformMonitorWorker({
            ...workerOptions,
            intervalMs: options.platformMonitorIntervalMs ?? env.WORKER_PLATFORM_MONITOR_INTERVAL_MS,
            batchSize: undefined,
            checks: createStandardPlatformChecks({
              workerStaleMultiplier: env.PLATFORM_MONITOR_WORKER_STALE_MULTIPLIER,
              // A worker that is switched off is not registered; one that is idle on purpose is not listed here.
              checkpointMaxAgeMs: (options.ledgerCheckpointEnabled ?? env.WORKER_LEDGER_CHECKPOINT_ENABLED)
                ? (options.ledgerCheckpointMaxAgeMs ?? env.LEDGER_CHECKPOINT_MAX_AGE_MS)
                : undefined,
              outboxMaxAgeMs: options.storage ? env.PLATFORM_MONITOR_OUTBOX_MAX_AGE_MS : undefined,
              auditOutboxMaxAgeMs:
                options.storage?.auditStore instanceof DedicatedAuditDatabaseDriver
                  ? env.PLATFORM_MONITOR_AUDIT_OUTBOX_MAX_AGE_MS
                  : undefined,
              backgroundJobMaxAgeMs: (options.backgroundJobsEnabled ?? env.WORKER_BACKGROUND_JOBS_ENABLED)
                ? env.WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS
                : undefined,
              kybScanBacklogMaxAgeMs:
                (options.kybScanEnabled ?? env.WORKER_KYB_SCAN_ENABLED)
                && (options.kybScanner ?? createKybScanner({ mode: env.KYB_SCANNER_MODE, clamdAddress: env.KYB_CLAMD_ADDRESS }))
                  ? env.PLATFORM_MONITOR_KYB_SCAN_MAX_AGE_MS
                  : undefined,
              certificateFiles: resolveCertificateFiles(),
              certificateWarnWithinMs: env.PLATFORM_MONITOR_CERT_WARN_DAYS * 24 * 60 * 60 * 1000,
              redisProbe: options.storage
                ? async () => {
                    const health = await options.storage!.health();
                    return health.cache.driver !== "redis" || health.cache.ok;
                  }
                : undefined,
            }),
            extraChecks: [
              createStaleUnknownMonitorCheck({ olderThanHours: env.UNKNOWN_ATTEMPT_CASE_SLA_HOURS }),
              createUnscheduledRefundMonitorCheck(),
              ...(platformMonitorEnabled
                ? [createObjectStorageMonitorCheck({ sdk: objectStorageSdk, prisma: options.db as unknown as PrismaClient })]
                : []),
              // AUTO-27: only when a backup daemon is configured (a deployment without one has nothing to watch).
              ...(env.BACKUP_DAEMON_URL
                ? [
                    createBackupMonitorCheck({
                      fetchOverview: () => getBackupControlClient().overview(),
                      maxFullAgeMs: env.PLATFORM_MONITOR_BACKUP_MAX_FULL_AGE_MS,
                      maxDrillAgeMs: env.PLATFORM_MONITOR_BACKUP_DRILL_MAX_AGE_MS,
                    }),
                  ]
                : []),
            ],
          }),
        ]
      : []),
  ];

  // The health/deploy probes expect exactly one holder for every singleton
  // key. The list is built from the workers that are actually enabled.
  const expectedLeaderKeys = workers.flatMap((worker) => {
    const candidate = worker as { clusterSingleton?: boolean; leaderKey?: string };
    return candidate.clusterSingleton === true && typeof candidate.leaderKey === "string"
      ? [candidate.leaderKey]
      : [];
  });
  options.storage?.leaderElection?.setExpected?.(expectedLeaderKeys);

  return {
    workers,
    start: () => {
      for (const worker of workers) {
        worker.start();
      }
    },
    stop: () => {
      for (const worker of workers) {
        worker.stop();
      }
    },
  };
};

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

let notificationVault: Vault | undefined;
let automationVault: Vault | undefined;

/**
 * Resolves the address a provider has to deliver a notification to.
 *
 * The address of a recipient is stored encrypted, so it is decrypted with the
 * platform vault. A recipient without an encrypted address (the development
 * setup) falls back to the masked address, which never leaves the platform as
 * a real contact point.
 */
const resolveNotificationRecipient: NotificationRecipientResolver = async (notification) => {
  const ciphertext = notification.addressCiphertext?.trim();
  if (!ciphertext) {
    return notification.addressMasked;
  }
  try {
    notificationVault ??= new Vault();
    return await notificationVault.decryptSecret(ciphertext);
  } catch {
    return notification.addressMasked;
  }
};

/**
 * Chooses the notification transport of the platform.
 *
 * With a configured aggregator endpoint (`NOTIFICATION_WEBHOOK_URL`) the
 * platform talks to the real provider, without one it keeps working in
 * development through the log transport, which reports `SENT` instead of
 * `DELIVERED`.
 */
export const resolveNotificationTransport = (
  options: ProductionWorkerRuntimeOptions,
): NotificationTransport =>
  options.notificationTransport
  ?? createNotificationTransport({
    webhookUrl: options.notificationTransportUrl ?? env.NOTIFICATION_WEBHOOK_URL ?? null,
    timeoutMs: options.notificationTransportTimeoutMs ?? env.NOTIFICATION_WEBHOOK_TIMEOUT_MS,
    masterKey: env.KMS_MASTER_KEY,
    resolveRecipient: resolveNotificationRecipient,
  });

export { toCamelRows };
