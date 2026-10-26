import { randomUUID } from "node:crypto";
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
}

export interface InboundEventHandler {
  handle(event: InboundEventRow): Promise<{ processed: boolean; result?: string }>;
}

export interface InboundInboxWorkerDeps extends WorkerOptions {
  handler?: InboundEventHandler;
  maxAttempts?: number;
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

  constructor(deps: InboundInboxWorkerDeps) {
    super(deps);
    this.handler = deps.handler;
    this.maxAttempts = deps.maxAttempts ?? 5;
  }

  protected async tick(): Promise<void> {
    if (!this.handler) {
      this.logger.warn("InboundInboxWorker: no handler registered, nothing to drain");
      return;
    }
    const events = await this.lockUnprocessedEvents();
    for (const event of events) {
      await this.processEvent(event);
    }
  }

  private async lockUnprocessedEvents(): Promise<InboundEventRow[]> {
    const sql =
      "SELECT * FROM inbound_events" +
      " WHERE processed_at IS NULL" +
      " ORDER BY received_at ASC" +
      " LIMIT $1" +
      " FOR UPDATE SKIP LOCKED";
    const result = await this.db.$queryRawUnsafe(sql, this.batchSize);
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
      await this.markFailed(event, attempt + 1, message);
      await this.openOperatorCase(event, message);
    }
  }

  private readAttemptCount(processingResult: string | null): number {
    if (!processingResult) return 0;
    const match = ATTEMPT_PATTERN.exec(processingResult);
    if (!match) return 0;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async markProcessed(event: InboundEventRow, result: string): Promise<void> {
    await this.db.$executeRawUnsafe(
      "UPDATE inbound_events SET processed_at = $1, processing_result = $2 WHERE id = $3",
      this.clock(),
      result.slice(0, 500),
      event.id,
    );
  }

  private async markRetry(event: InboundEventRow, attempt: number, message: string): Promise<void> {
    await this.db.$executeRawUnsafe(
      "UPDATE inbound_events SET processing_result = $1 WHERE id = $2",
      `RETRY(${attempt}):${message}`.slice(0, 500),
      event.id,
    );
  }

  private async markFailed(event: InboundEventRow, attempt: number, message: string): Promise<void> {
    await this.db.$executeRawUnsafe(
      "UPDATE inbound_events SET processed_at = $1, processing_result = $2 WHERE id = $3",
      this.clock(),
      `FAILED(${attempt}):${message}`.slice(0, 500),
      event.id,
    );
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
      "SELECT id FROM inbound_events WHERE channel_id = $1 AND dedupe_key = $2 LIMIT 1",
      input.channelId,
      input.dedupeKey,
    );
    const found = Array.isArray(existing) ? (existing as { id: string }[])[0] : undefined;
    if (found?.id) {
      return { id: found.id, duplicate: true };
    }
    await this.db.$executeRawUnsafe(
      "INSERT INTO inbound_events (id, channel_id, gateway_id, env, raw_body_bytes, redacted_headers_json, source_ip, verified, verification_error, dedupe_key, attempt_id, received_at)" +
        " VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
      randomUUID(),
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
      this.clock(),
    );
    const inserted = await this.db.$queryRawUnsafe(
      "SELECT id FROM inbound_events WHERE channel_id = $1 AND dedupe_key = $2 LIMIT 1",
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
