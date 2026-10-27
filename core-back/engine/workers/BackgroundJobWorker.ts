import { toCamelRows } from "../db/rawRows";
import type { BackgroundJobRow, BackgroundJobType, Tx } from "../db/ports";
import { BaseWorker, backoffDelayMs, type WorkerOptions } from "./workerRuntime";

/**
 * The handler of one kind of background job.
 *
 * A handler that throws makes the job fail: the worker records the error,
 * re-queues the job with a backoff and gives up when the attempts are
 * exhausted. A handler therefore has to be idempotent, because a job can be
 * executed more than once.
 */
export interface BackgroundJobHandler {
  handle(job: BackgroundJobRow): Promise<void>;
}

export type BackgroundJobHandlers = Partial<Record<BackgroundJobType, BackgroundJobHandler>>;

export interface BackgroundJobWorkerDeps extends WorkerOptions {
  /**
   * The handlers of the job types, keyed by the job type.
   */
  handlers?: BackgroundJobHandlers;
  /**
   * The lease of a claimed job: a job that is still `RUNNING` when its lease
   * expired was left behind by a crashed node and is re-queued.
   */
  leaseSeconds?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  defaultMaxAttempts?: number;
}

/**
 * The durable job queue of `core-back`.
 *
 * The queue is drained by stateless nodes: every node claims the due jobs
 * with `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction, so two nodes
 * never work on the same job, and a crashed node never loses a job: the
 * lease of a `RUNNING` job expires and the job is re-queued.
 */
export class BackgroundJobWorker extends BaseWorker {
  private readonly handlers: BackgroundJobHandlers;
  private readonly leaseSeconds: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly defaultMaxAttempts: number;

  constructor(deps: BackgroundJobWorkerDeps) {
    super(deps);
    this.handlers = deps.handlers ?? {};
    this.leaseSeconds = deps.leaseSeconds ?? 300;
    this.baseBackoffMs = deps.baseBackoffMs ?? 30_000;
    this.maxBackoffMs = deps.maxBackoffMs ?? 30 * 60_000;
    this.defaultMaxAttempts = deps.defaultMaxAttempts ?? 5;
  }

  protected async tick(): Promise<void> {
    // A job of a crashed node is recovered before the new work is claimed,
    // so a lost node never strands its jobs.
    await this.recoverExpiredLeases();
    const jobs = await this.claimDueJobs();
    for (const job of jobs) {
      await this.runJob(job);
    }
  }

  /**
   * Claims the due jobs.
   *
   * The selection and the marking happen in one transaction: the row lock
   * that `SKIP LOCKED` takes is held until the job is marked as `RUNNING`,
   * so a second node skips the very same job.
   */
  private async claimDueJobs(): Promise<BackgroundJobRow[]> {
    const now = this.clock();
    return this.db.$transaction(async (tx: Tx) => {
      const sql =
        "SELECT * FROM background_jobs" +
        " WHERE state = 'QUEUED'" +
        " AND available_at <= ?" +
        " ORDER BY available_at ASC, created_at ASC" +
        " LIMIT ?" +
        " FOR UPDATE SKIP LOCKED";
      const rows = await tx.$queryRawUnsafe(sql, now, this.batchSize);
      const jobs = toCamelRows<BackgroundJobRow>(rows);
      for (const job of jobs) {
        await tx.$executeRawUnsafe(
          "UPDATE background_jobs" +
          " SET state = 'RUNNING', locked_at = ?, updated_at = ?" +
          " WHERE id = ? AND state = 'QUEUED'",
          now,
          now,
          job.id,
        );
      }
      return jobs;
    }) as Promise<BackgroundJobRow[]>;
  }

  /**
   * Re-queues the jobs of a crashed node.
   *
   * A job that is still `RUNNING` when its lease expired belongs to a node
   * that died. The update is conditional, so a job that is still running
   * normally is never taken away from its node.
   */
  private async recoverExpiredLeases(): Promise<void> {
    const now = this.clock();
    const leaseExpiredAt = new Date(now.getTime() - this.leaseSeconds * 1000);
    const affected = await this.db.$executeRawUnsafe(
      "UPDATE background_jobs" +
      " SET state = 'QUEUED', locked_at = NULL, available_at = ?, updated_at = ?" +
      " WHERE state = 'RUNNING' AND locked_at IS NOT NULL AND locked_at <= ?",
      now,
      now,
      leaseExpiredAt,
    );
    const recovered = Number(affected ?? 0);
    if (recovered > 0) {
      this.logger.warn("BackgroundJobWorker: recovered the jobs of a crashed node", {
        recovered,
        leaseSeconds: this.leaseSeconds,
      });
    }
  }

  private async runJob(job: BackgroundJobRow): Promise<void> {
    const handler = this.handlers[job.jobType];
    if (!handler) {
      await this.fail(job, `No handler is registered for the job type '${job.jobType}'`);
      return;
    }
    try {
      await handler.handle(job);
      await this.succeed(job);
    } catch (error) {
      await this.fail(job, error instanceof Error ? error.message : String(error));
    }
  }

  private async succeed(job: BackgroundJobRow): Promise<void> {
    const now = this.clock();
    await this.db.$executeRawUnsafe(
      "UPDATE background_jobs" +
      " SET state = 'SUCCEEDED', completed_at = ?, locked_at = NULL, updated_at = ?" +
      " WHERE id = ?",
      now,
      now,
      job.id,
    );
    this.logger.info("BackgroundJobWorker: job finished", {
      jobId: job.id,
      jobType: job.jobType,
      referenceId: job.referenceId,
    });
  }

  /**
   * Records the failure of a job.
   *
   * The job is re-queued with an exponential backoff until its attempts are
   * exhausted; the last failure marks the job as `FAILED`, so the queue never
   * retries a hopeless job forever.
   */
  private async fail(job: BackgroundJobRow, reason: string): Promise<void> {
    const now = this.clock();
    const attempts = job.attempts + 1;
    const maxAttempts = job.maxAttempts > 0 ? job.maxAttempts : this.defaultMaxAttempts;
    const message = reason.slice(0, 2000);
    if (attempts >= maxAttempts) {
      await this.db.$executeRawUnsafe(
        "UPDATE background_jobs" +
        " SET state = 'FAILED', attempts = ?, last_error = ?, completed_at = ?, locked_at = NULL, updated_at = ?" +
        " WHERE id = ?",
        attempts,
        message,
        now,
        now,
        job.id,
      );
      this.logger.error("BackgroundJobWorker: job permanently failed", {
        jobId: job.id,
        jobType: job.jobType,
        referenceId: job.referenceId,
        attempts,
        reason: message,
      });
      return;
    }
    const delay = backoffDelayMs(attempts, this.baseBackoffMs, this.maxBackoffMs);
    await this.db.$executeRawUnsafe(
      "UPDATE background_jobs" +
      " SET state = 'QUEUED', attempts = ?, last_error = ?, available_at = ?, locked_at = NULL, updated_at = ?" +
      " WHERE id = ?",
      attempts,
      message,
      new Date(now.getTime() + delay),
      now,
      job.id,
    );
    this.logger.warn("BackgroundJobWorker: job failed, will retry", {
      jobId: job.id,
      jobType: job.jobType,
      referenceId: job.referenceId,
      attempts,
      retryInMs: delay,
      reason: message,
    });
  }
}
