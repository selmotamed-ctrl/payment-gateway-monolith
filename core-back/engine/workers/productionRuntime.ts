import type { PrismaLike } from "../db/ports";
import { getPlatformRuntime } from "../runtime";
import type { InquiryOutcome, InquiryPort } from "./ExpirySweeperWorker";
import type { InboundEventHandler } from "./InboundInboxWorker";
import type { NotificationSender } from "./OutboxNotificationWorker";
import { ExpirySweeperWorker } from "./ExpirySweeperWorker";
import { PollWorker } from "./PollWorker";
import { InboundInboxWorker } from "./InboundInboxWorker";
import { OutboxNotificationWorker } from "./OutboxNotificationWorker";
import { LedgerInvariantWorker } from "./LedgerInvariantWorker";
import { PrismaRepositories } from "../db/repositories";
import { toCamelRows } from "../db/rawRows";

export interface ProductionWorkerRuntimeOptions {
  db: PrismaLike;
  intervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  notificationTransportUrl?: string;
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

  const sender: NotificationSender = {
    send: async (notification, rendered) => {
      const providerMessageId = `local-${notification.id}`;
      console.log(
        `[notification] ${notification.channel} ${notification.templateCode} -> ${notification.addressMasked} :: ${rendered.body}`,
      );
      return { status: "DELIVERED", providerMessageId };
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

export { toCamelRows };
