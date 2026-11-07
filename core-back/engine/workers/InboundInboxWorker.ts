import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ApiError } from "../../lib/error";
import { toCamelRows } from "../db/rawRows";
import type { Tx } from "../db/ports";
import { BaseWorker, type WorkerOptions } from "./workerRuntime";

export interface InboundEventRow {
  id: string;
  channelId: string;
  gatewayId: string;
  env: string;
  rawBodyBytes: unknown;
  redactedHeadersJson: unknown;
  sourceIp: string | null;
  verified: boolean;
  verificationError: string | null;
  dedupeKey: string;
  attemptId: string | null;
  receivedAt: Date;
  processedAt: Date | null;
  processingResult: string | null;
  claimedAt?: Date | null;
  claimedBy?: string | null;
}

export interface InboundEventHandler {
  handle(event: InboundEventRow): Promise<{ processed: boolean; result?: string }>;
}

export interface InboundInboxWorkerDeps extends WorkerOptions {
  handler?: InboundEventHandler;
  maxAttempts?: number;
  /**
   * Stable identifier written on the claim. Defaults to `NODE_ID`, then the
   * hostname; it only has to identify the claimant in the lease/finalize SQL.
   */
  workerId?: string;
}

export class RetryableInboundError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "RetryableInboundError";
  }
}

const ATTEMPT_PATTERN = /RETRY\((\d+)\)/;

export class InboundInboxWorker extends BaseWorker {
  private readonly handler: InboundEventHandler | undefined;
  private readonly maxAttempts: number;
  private readonly workerId: string;

  protected override get singleton(): boolean {
    return true;
  }

  constructor(deps: InboundInboxWorkerDeps) {
    super(deps);
    this.handler = deps.handler;
    this.maxAttempts = deps.maxAttempts ?? 5;
    this.workerId = deps.workerId ?? process.env.NODE_ID ?? hostname() ?? "core-back";
  }

  protected async tick(): Promise<void> {
    if (!this.handler) {
      this.logger.warn("InboundInboxWorker: no handler registered, nothing to drain");
      return;
    }
    const events = await this.claimEvents();
    for (const event of events) {
      await this.processEvent(event);
    }
  }

  /**
   * Claims a batch with a durable lease.
   *
   * `FOR UPDATE SKIP LOCKED` alone is not enough here: the row locks end when
   * the claim transaction commits, while the handler runs outside it. The
   * `claimed_at`/`claimed_by` write persists the claim, so two nodes (even if
   * leadership briefly overlaps) cannot process the same webhook. A crashed
   * claimant's rows are reclaimed after `claimLeaseSeconds`.
   */
  private async claimEvents(): Promise<InboundEventRow[]> {
    const now = this.clock();
    const staleBefore = new Date(now.getTime() - this.claimLeaseSeconds * 1000);
    const sql =
      "WITH candidate AS (" +
      " SELECT id FROM inbound_events" +
      " WHERE processed_at IS NULL" +
      "   AND (claimed_at IS NULL OR claimed_at < $2)" +
      " ORDER BY received_at ASC" +
      " LIMIT $1" +
      " FOR UPDATE SKIP LOCKED" +
      ")" +
      " UPDATE inbound_events e" +
      " SET claimed_at = $3, claimed_by = $4, updated_at = $3" +
      " FROM candidate" +
      " WHERE e.id = candidate.id" +
      " RETURNING e.*";
    const result = await this.inTransaction((tx) =>
      tx.$queryRawUnsafe(sql, this.batchSize, staleBefore, now, this.workerId),
    );
    return toCamelRows<InboundEventRow>(result);
  }

  private async processEvent(event: InboundEventRow): Promise<void> {
    const attempt = this.readAttemptCount(event.processingResult);
    try {
      const outcome = await this.handler!.handle(event);
      await this.markProcessed(event, outcome.processed ? (outcome.result ?? "PROCESSED") : "SKIPPED");
    } catch (error) {
      const retryable = error instanceof RetryableInboundError;
      const message = (error as Error).message;
      if (retryable && attempt + 1 < this.maxAttempts) {
        await this.markRetry(event, attempt + 1, message);
        return;
      }
      const failed = await this.markFailed(event, attempt + 1, message);
      if (failed) {
        await this.openOperatorCase(event, message);
      }
    }
  }

  private readAttemptCount(processingResult: string | null): number {
    if (!processingResult) return 0;
    const match = ATTEMPT_PATTERN.exec(processingResult);
    if (!match) return 0;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /** Records the result only while this node still owns the claim. */
  private async markProcessed(event: InboundEventRow, result: string): Promise<boolean> {
    const now = this.clock();
    const updated = await this.db.$executeRawUnsafe(
      "UPDATE inbound_events SET processed_at = $1, processing_result = $2, claimed_at = NULL, claimed_by = NULL, updated_at = $1" +
        " WHERE id = $3::uuid AND claimed_by = $4 AND processed_at IS NULL",
      now,
      result.slice(0, 500),
      event.id,
      this.workerId,
    );
    if (Number(updated ?? 0) === 0) {
      this.logger.warn("InboundInboxWorker: claim was lost before the result was recorded", {
        eventId: event.id,
      });
      return false;
    }
    return true;
  }

  private async markRetry(event: InboundEventRow, attempt: number, message: string): Promise<boolean> {
    const updated = await this.db.$executeRawUnsafe(
      "UPDATE inbound_events SET processing_result = $1, claimed_at = NULL, claimed_by = NULL, updated_at = $2" +
        " WHERE id = $3::uuid AND claimed_by = $4 AND processed_at IS NULL",
      `RETRY(${attempt}):${message}`.slice(0, 500),
      this.clock(),
      event.id,
      this.workerId,
    );
    if (Number(updated ?? 0) === 0) {
      this.logger.warn("InboundInboxWorker: claim was lost before the retry was recorded", {
        eventId: event.id,
      });
      return false;
    }
    return true;
  }

  private async markFailed(event: InboundEventRow, attempt: number, message: string): Promise<boolean> {
    const now = this.clock();
    const updated = await this.db.$executeRawUnsafe(
      "UPDATE inbound_events SET processed_at = $1, processing_result = $2, claimed_at = NULL, claimed_by = NULL, updated_at = $1" +
        " WHERE id = $3::uuid AND claimed_by = $4 AND processed_at IS NULL",
      now,
      `FAILED(${attempt}):${message}`.slice(0, 500),
      event.id,
      this.workerId,
    );
    if (Number(updated ?? 0) === 0) {
      this.logger.warn("InboundInboxWorker: claim was lost before the failure was recorded", {
        eventId: event.id,
      });
      return false;
    }
    return true;
  }

  private async openOperatorCase(event: InboundEventRow, message: string): Promise<void> {
    try {
      await this.repositories.risk.createOperatorCase(this.db as Tx, {
        attemptId: event.attemptId,
        kind: "UNKNOWN",
        priority: "P2",
        state: "OPEN",
        slaDueAt: new Date(this.clock().getTime() + 4 * 60 * 60 * 1000),
        resolutionNotes: `Inbound event ${event.id} failed processing: ${message}`.slice(0, 1000),
      });
    } catch (error) {
      this.logger.error("InboundInboxWorker: unable to open operator case", {
        eventId: event.id,
        error: (error as Error).message,
      });
    }
  }

  async persistInboundEvent(input: {
    channelId: string;
    gatewayId: string;
    env: string;
    rawBody: Buffer | Uint8Array | string;
    headers: Record<string, unknown>;
    sourceIp: string | null;
    verified: boolean;
    verificationError: string | null;
    dedupeKey: string;
    attemptId?: string | null;
  }): Promise<{ id: string; duplicate: boolean }> {
    const body = typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : Buffer.from(input.rawBody);
    const existing = await this.db.$queryRawUnsafe(
      "SELECT id FROM inbound_events WHERE channel_id = $1::uuid AND dedupe_key = $2 LIMIT 1",
      input.channelId,
      input.dedupeKey,
    );
    const found = Array.isArray(existing) ? (existing as { id: string }[])[0] : undefined;
    if (found?.id) {
      return { id: found.id, duplicate: true };
    }
    // `updated_at` has no database default, so the raw insert has to carry it.
    const now = this.clock();
    await this.db.$executeRawUnsafe(
      "INSERT INTO inbound_events (id, created_at, updated_at, channel_id, gateway_id, env, raw_body_bytes, redacted_headers_json, source_ip, verified, verification_error, dedupe_key, attempt_id, received_at)" +
        " VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::uuid, $14)",
      randomUUID(),
      now,
      now,
      input.channelId,
      input.gatewayId,
      input.env,
      body,
      JSON.stringify(input.headers ?? {}),
      input.sourceIp,
      input.verified,
      input.verificationError,
      input.dedupeKey,
      input.attemptId ?? null,
      now,
    );
    const inserted = await this.db.$queryRawUnsafe(
      "SELECT id FROM inbound_events WHERE channel_id = $1::uuid AND dedupe_key = $2 LIMIT 1",
      input.channelId,
      input.dedupeKey,
    );
    const row = Array.isArray(inserted) ? (inserted as { id: string }[])[0] : undefined;
    if (!row?.id) {
      throw new ApiError(500, "INBOUND_EVENT_PERSIST_FAILED", "Inbound event could not be persisted");
    }
    return { id: row.id, duplicate: false };
  }
}
