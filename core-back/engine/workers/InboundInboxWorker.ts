import { randomUUID } from "node:crypto";
import { ApiError } from "../../lib/error";
import { mysqlPlaceholders, toCamelRows } from "../db/rawRows";
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
const INBOUND_EVENT_CLAIM_COLUMNS = [
  "id", "created_at", "updated_at", "channel_id", "gateway_id", "env",
  "source_ip", "verified", "verification_error", "dedupe_key", "attempt_id",
  "received_at", "processed_at", "processing_result",
].join(", ");

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
      `SELECT ${INBOUND_EVENT_CLAIM_COLUMNS} FROM inbound_events` +
      " WHERE processed_at IS NULL" +
      " ORDER BY received_at ASC" +
      " LIMIT ?" +
      " FOR UPDATE SKIP LOCKED";
    // The claim never selects the LONGBLOB / JSON payload. The selection is
    // kept in one transaction; the payload is then loaded only for the
    // claimed ids, and the handler still runs outside any transaction.
    const events = await this.db.$transaction(async (tx: Tx) => {
      const result = await tx.$queryRawUnsafe(sql, this.batchSize);
      return toCamelRows<InboundEventRow>(result);
    });
    return this.attachPayloads(events);
  }

  private async attachPayloads(events: InboundEventRow[]): Promise<InboundEventRow[]> {
    if (events.length === 0) {
      return events;
    }
    const payloads = new Map<string, Record<string, unknown>>();
    const collect = (value: unknown, idKeys: string[]): void => {
      for (const row of toCamelRows<Record<string, unknown>>(value)) {
        const id = idKeys.map((key) => row[key]).find((candidate) => typeof candidate === "string");
        if (typeof id !== "string") continue;
        if (row.rawBodyBytes === undefined && row.redactedHeadersJson === undefined) continue;
        payloads.set(id, row);
      }
    };
    // The split payload may already be offloaded to `inbound_event_payloads`.
    try {
      const placeholders = mysqlPlaceholders(events.length);
      const split = await this.db.$queryRawUnsafe(
        `SELECT event_id, raw_body_bytes, redacted_headers_json
           FROM inbound_event_payloads WHERE event_id IN (${placeholders})`,
        ...events.map((event) => event.id),
      );
      collect(split, ["eventId", "event_id"]);
    } catch {
      // A deployment that has not created the offload table yet keeps the
      // inline payload below.
    }
    const missing = events.filter((event) => !payloads.has(event.id));
    if (missing.length > 0) {
      try {
        const placeholders = mysqlPlaceholders(missing.length);
        const inline = await this.db.$queryRawUnsafe(
          `SELECT id, raw_body_bytes, redacted_headers_json
             FROM inbound_events WHERE id IN (${placeholders})`,
          ...missing.map((event) => event.id),
        );
        collect(inline, ["id"]);
      } catch {
        // The handler still receives the row headers and reports its own
        // result when the payload cannot be read.
      }
    }
    return events.map((event) => {
      const payload = payloads.get(event.id);
      if (!payload) {
        return event;
      }
      return {
        ...event,
        ...(payload.rawBodyBytes !== undefined ? { rawBodyBytes: payload.rawBodyBytes } : {}),
        ...(payload.redactedHeadersJson !== undefined
          ? { redactedHeadersJson: payload.redactedHeadersJson }
          : {}),
      };
    });
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
      "UPDATE inbound_events SET processed_at = ?, processing_result = ? WHERE id = ?",
      this.clock(),
      result.slice(0, 500),
      event.id,
    );
  }

  private async markRetry(event: InboundEventRow, attempt: number, message: string): Promise<void> {
    await this.db.$executeRawUnsafe(
      "UPDATE inbound_events SET processing_result = ? WHERE id = ?",
      `RETRY(${attempt}):${message}`.slice(0, 500),
      event.id,
    );
  }

  private async markFailed(event: InboundEventRow, attempt: number, message: string): Promise<void> {
    await this.db.$executeRawUnsafe(
      "UPDATE inbound_events SET processed_at = ?, processing_result = ? WHERE id = ?",
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
      "SELECT id FROM inbound_events WHERE channel_id = ? AND dedupe_key = ? LIMIT 1",
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
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      "SELECT id FROM inbound_events WHERE channel_id = ? AND dedupe_key = ? LIMIT 1",
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
