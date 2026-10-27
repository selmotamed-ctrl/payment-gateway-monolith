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
import { LedgerInvariantWorker } from "./LedgerInvariantWorker";
import { JoinRequestExpiryWorker } from "./JoinRequestExpiryWorker";
import { PeriodicScreeningWorker } from "./PeriodicScreeningWorker";
import { RetentionWorker } from "./RetentionWorker";
import { BackgroundJobWorker } from "./BackgroundJobWorker";
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
  };

  const workers = [
    new ExpirySweeperWorker({ ...workerOptions, inquiry }),
    new PollWorker({ ...workerOptions, inquiry }),
    new InboundInboxWorker({ ...workerOptions, handler, maxAttempts: options.maxAttempts }),
    new OutboxNotificationWorker({ ...workerOptions, sender }),
    new LedgerInvariantWorker(workerOptions),
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
              }),
            },
          }),
        ]
      : []),
  ];

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
