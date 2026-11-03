import { ApiError } from "../../lib/error";
import { toCamelRows } from "../db/rawRows";
import type { Tx } from "../db/ports";
import { BaseWorker, type WorkerOptions } from "./workerRuntime";

export interface InboundEventRow {
  id: string;
  channelId: string;
  gatewayId: string;
  env: string;
  rawBodyBytes?: unknown;
  redactedHeadersJson?: unknown;
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

const INBOUND_EVENT_COLUMNS = [
  "id",
  "channel_id",
  "gateway_id",
  "env",
  "source_ip",
  "verified",
  "verification_error",
  "dedupe_key",
  "attempt_id",
  "received_at",
  "processed_at",
  "processing_result",
  "created_at",
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
      await this.processEvent(await this.attachPayload(event));
    }
  }

  private async lockUnprocessedEvents(): Promise<InboundEventRow[]> {
    const result = await this.db.$queryRawUnsafe(
      `SELECT ${INBOUND_EVENT_COLUMNS}
         FROM inbound_events
        WHERE processed_at IS NULL
        ORDER BY received_at ASC
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      this.batchSize,
    );
    return toCamelRows<InboundEventRow>(result);
  }

  private async attachPayload(event: InboundEventRow): Promise<InboundEventRow> {
    try {
      const client = this.db as Record<string, any>;
      const payload = client.inboundEventPayload?.findUnique
        ? await client.inboundEventPayload.findUnique({
            where: { eventId: BigInt(String(event.id)) },
          })
        : undefined;
      if (payload) {
        return {
          ...event,
          rawBodyBytes: payload.rawBodyBytes,
          redactedHeadersJson: payload.redactedHeadersJson,
        };
      }
      if (!client.inboundEventPayload?.findUnique) {
        const rows = (await this.db.$queryRawUnsafe(
          "SELECT raw_body_bytes, redacted_headers_json FROM inbound_event_payloads WHERE event_id = ? LIMIT 1",
          event.id,
        )) as Array<Record<string, unknown>>;
        const row = Array.isArray(rows) ? rows[0] : undefined;
        if (row) {
          return {
            ...event,
            rawBodyBytes: row.raw_body_bytes ?? row.rawBodyBytes,
            redactedHeadersJson: row.redacted_headers_json ?? row.redactedHeadersJson,
          };
        }
      }
    } catch (error) {
      this.logger.warn("InboundInboxWorker: unable to load the event payload", {
        eventId: event.id,
        error: (error as Error).message,
      });
    }
    return event;
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
      return { id: String(found.id), duplicate: true };
    }
    const now = this.clock();
    const client = this.db as Record<string, any>;
    if (client.inboundEvent?.create && client.inboundEventPayload?.create) {
      const parent = await this.db.$transaction(async (tx: Tx) => {
        const txClient = tx as Record<string, any>;
        const created = await txClient.inboundEvent.create({
          data: {
            createdAt: now,
            channelId: input.channelId,
            gatewayId: input.gatewayId,
            env: input.env,
            sourceIp: input.sourceIp ?? "",
            verified: input.verified,
            verificationError: input.verificationError,
            dedupeKey: input.dedupeKey,
            attemptId: input.attemptId ?? null,
            receivedAt: now,
          },
        });
        await txClient.inboundEventPayload.create({
          data: {
            eventId: created.id,
            rawBodyBytes: body,
            redactedHeadersJson: input.headers ?? {},
            createdAt: now,
          },
        });
        return created;
      });
      return { id: String(parent.id), duplicate: false };
    }
    const id = await this.db.$transaction(async (tx: Tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO inbound_events
          (created_at, channel_id, gateway_id, env, source_ip, verified, verification_error, dedupe_key, attempt_id, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        now,
        input.channelId,
        input.gatewayId,
        input.env,
        input.sourceIp ?? "",
        input.verified,
        input.verificationError,
        input.dedupeKey,
        input.attemptId ?? null,
        now,
      );
      const rows = (await tx.$queryRawUnsafe("SELECT LAST_INSERT_ID() AS id")) as Array<Record<string, unknown>>;
      const insertedId = rows[0]?.id;
      await tx.$executeRawUnsafe(
        `INSERT INTO inbound_event_payloads (event_id, raw_body_bytes, redacted_headers_json, created_at)
         VALUES (?, ?, ?, ?)`,
        insertedId,
        body,
        JSON.stringify(input.headers ?? {}),
        now,
      );
      return String(insertedId ?? "");
    });
    if (!id || id === "undefined") {
      throw new ApiError(500, "INBOUND_EVENT_PERSIST_FAILED", "Inbound event could not be persisted");
    }
    return { id, duplicate: false };
  }
}
