import type { PrismaLike } from "../db/ports";
import { PrismaRepositories } from "../db/repositories";
import { ExpirySweeperWorker } from "./ExpirySweeperWorker";
import { PollWorker } from "./PollWorker";
import { InboundInboxWorker } from "./InboundInboxWorker";
import { OutboxNotificationWorker } from "./OutboxNotificationWorker";

export interface WorkerRuntimeOptions {
  db: PrismaLike;
  intervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
}

export interface WorkerRuntime {
  workers: BaseWorkerLike[];
  start: () => void;
  stop: () => void;
}

interface BaseWorkerLike {
  start: () => void;
  stop: () => void;
  readonly isRunning: boolean;
}

export const createWorkerRuntime = (options: WorkerRuntimeOptions): WorkerRuntime => {
  const repositories = new PrismaRepositories(options.db);
  const workerOptions = {
    db: options.db,
    repositories,
    intervalMs: options.intervalMs,
    batchSize: options.batchSize,
  };

  const workers: BaseWorkerLike[] = [
    new ExpirySweeperWorker(workerOptions),
    new PollWorker(workerOptions),
    new InboundInboxWorker({ ...workerOptions, maxAttempts: options.maxAttempts }),
    new OutboxNotificationWorker(workerOptions),
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
