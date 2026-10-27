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
import { PeriodicScreeningWorker } from "./PeriodicScreeningWorker";
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
}

export interface ProductionWorkerRuntime {
  workers: Array<{ start: () => void; stop: () => void; readonly isRunning: boolean }>;
  start: () => void;
  stop: () => void;
}

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
    // The ongoing screening layer (L2) re-screens the active merchants
    // against the watch list and raises a case for a merchant that became a
    // confirmed match after its onboarding.
    new PeriodicScreeningWorker({
      ...workerOptions,
      screening: platform.screening,
      rescreenIntervalMs: options.rescreenIntervalMs,
    }),
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
