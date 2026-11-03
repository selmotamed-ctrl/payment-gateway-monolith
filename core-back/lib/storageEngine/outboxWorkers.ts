import type { PrismaClient } from "../../generated/prisma/client";
import { computeAuditRowHash, DedicatedAuditDatabaseDriver } from "./auditAndLogAdapters";
import type { AuditHashInput } from "./auditAndLogAdapters";
import type { OutboxEnvelope } from "./ports";

export interface WorkerLoggerLike {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
}

interface OutboxRow {
  id: string | number;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  merchant_id: string | null;
  payload_json: unknown;
  created_at: Date;
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asRecord(parsed);
    } catch {
      return {};
    }
  }
  return {};
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asMoney = (value: unknown): string => {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric.toFixed(4) : "0.0000";
};

const dayOf = (value: unknown, fallback: Date): string => {
  const text = typeof value === "string" ? value : null;
  if (text && /^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }
  return fallback.toISOString().slice(0, 10);
};

const statusKind = (status: string | null): "success" | "failure" | "open" => {
  if (status === "SUCCEEDED") {
    return "success";
  }
  if (status === "FAILED" || status === "EXPIRED" || status === "CANCELLED") {
    return "failure";
  }
  return "open";
};

export type OutboxHandler = (
  event: OutboxEnvelope,
  tx: PrismaClient,
) => Promise<void>;

export const projectAttemptTransition = async (
  event: OutboxEnvelope,
  db: PrismaClient,
): Promise<void> => {
  const payload = asRecord(event.payload);
  const merchantId = asString(payload.merchantId) ?? event.merchantId ?? null;
  const routeId = asString(payload.routeId);
  const currency = asString(payload.currency) ?? "LYD";
  const status = asString(payload.status);
  const kind = statusKind(status);
  const occurredAt = payload.occurredAt ? new Date(String(payload.occurredAt)) : new Date();
  const day = dayOf(payload.occurredAt, occurredAt);
  const amount = asMoney(payload.totalChargedAmount);
  const net = asMoney(payload.netMerchantAmount);
  // Older outbox rows do not carry the lifecycle marker; treat them as the
  // creation event so the historical read-model semantics (attempt_count and
  // gross volume for every attempt) are preserved.
  const eventKind = asString(payload.event) ?? "created";
  const created = eventKind === "created" ? 1 : 0;
  const success = kind === "success" ? 1 : 0;
  const failure = kind === "failure" ? 1 : 0;
  const moneyPositive = eventKind === "created";

  if (merchantId) {
    await db.$executeRawUnsafe(
      `INSERT INTO rm_merchant_daily_stats
         (merchant_id, day, currency, attempt_count, success_count, failure_count, gross_amount, net_amount, updated_at)
       VALUES ($1::uuid, $2::date, $3, $4, $5, $6, $7::numeric, $8::numeric, now())
       ON CONFLICT (merchant_id, day, currency) DO UPDATE SET
         attempt_count = rm_merchant_daily_stats.attempt_count + EXCLUDED.attempt_count,
         success_count = rm_merchant_daily_stats.success_count + EXCLUDED.success_count,
         failure_count = rm_merchant_daily_stats.failure_count + EXCLUDED.failure_count,
         gross_amount = rm_merchant_daily_stats.gross_amount + EXCLUDED.gross_amount,
         net_amount = rm_merchant_daily_stats.net_amount + EXCLUDED.net_amount,
         updated_at = now()`,
      merchantId,
      day,
      currency,
      created,
      success,
      failure,
      moneyPositive ? amount : "0.0000",
      moneyPositive ? net : "0.0000",
    );
  }

  if (routeId) {
    await db.$executeRawUnsafe(
      `INSERT INTO rm_route_daily_volumes
         (route_id, day, currency, attempt_count, success_count, volume_amount, updated_at)
       VALUES ($1::uuid, $2::date, $3, $4, $5, $6::numeric, now())
       ON CONFLICT (route_id, day, currency) DO UPDATE SET
         attempt_count = rm_route_daily_volumes.attempt_count + EXCLUDED.attempt_count,
         success_count = rm_route_daily_volumes.success_count + EXCLUDED.success_count,
         volume_amount = rm_route_daily_volumes.volume_amount + EXCLUDED.volume_amount,
         updated_at = now()`,
      routeId,
      day,
      currency,
      created,
      success,
      moneyPositive ? amount : "0.0000",
    );
  }
};

export class OutboxRelayWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private readonly handlers: Record<string, OutboxHandler>;

  constructor(
    private readonly db: PrismaClient,
    private readonly options: {
      intervalMs?: number;
      batchSize?: number;
      handlers?: Record<string, OutboxHandler>;
      logger?: WorkerLoggerLike;
    } = {},
  ) {
    this.handlers = {
      "attempt.transitioned": projectAttemptTransition,
      "ledger.entry_posted": async () => undefined,
      "merchant.updated": async () => undefined,
      "kyb.document_uploaded": async () => undefined,
      "reconciliation.completed": async () => undefined,
      "config.invalidated": async () => undefined,
      ...options.handlers,
    };
  }

  public get isRunning(): boolean {
    return this.running;
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopped = false;
    this.schedule(0);
  }

  public stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public async runOnce(): Promise<void> {
    await this.drain();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.drain();
    } catch (error) {
      this.options.logger?.error?.("outbox relay failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.schedule(this.options.intervalMs ?? 250);
    }
  }

  public async drain(): Promise<number> {
    const batchSize = this.options.batchSize ?? 100;
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<OutboxRow[]>(
        `SELECT id, topic, aggregate_type, aggregate_id, merchant_id, payload_json, created_at
         FROM outbox_events
         WHERE processed_at IS NULL
         ORDER BY id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        batchSize,
      );

      if (rows.length === 0) {
        return 0;
      }

      for (const row of rows) {
        const event: OutboxEnvelope = {
          topic: row.topic as OutboxEnvelope["topic"],
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          merchantId: row.merchant_id,
          payload: asRecord(row.payload_json),
        };
        const handler = this.handlers[event.topic];
        if (handler) {
          await handler(event, tx as unknown as PrismaClient);
        }
        await tx.$executeRawUnsafe(
          `UPDATE outbox_events SET processed_at = now() WHERE id = $1`,
          row.id,
        );
      }
      return rows.length;
    });
  }
}

interface AuditOutboxRow {
  id: string;
  actor_id: string;
  actor_email: string | null;
  role: string;
  action: string;
  entity_type: string;
  entity_id: string;
  merchant_id: string | null;
  approval_request_id: string | null;
  request_id: string | null;
  client_ip: string | null;
  user_agent: string | null;
  before_json: unknown;
  after_json: unknown;
  created_at: Date;
}

export class AuditShipperWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly db: PrismaClient,
    private readonly auditStore: DedicatedAuditDatabaseDriver,
    private readonly options: {
      intervalMs?: number;
      batchSize?: number;
      logger?: WorkerLoggerLike;
    } = {},
  ) {}

  public get isRunning(): boolean {
    return this.running;
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopped = false;
    this.schedule(0);
  }

  public stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public async runOnce(): Promise<void> {
    await this.drain();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.drain();
    } catch (error) {
      this.options.logger?.error?.("audit shipper failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.schedule(this.options.intervalMs ?? 500);
    }
  }

  public async drain(): Promise<number> {
    const batchSize = this.options.batchSize ?? 100;
    // Claim a batch in a short transaction. The audit insert is idempotent on
    // the source id, so if this process dies after the audit database append
    // but before the shipped_at update, the next pass re-appends the same ids
    // and the audit database ignores them instead of duplicating the chain.
    const rows = await this.db.$transaction(async (tx) =>
      tx.$queryRawUnsafe<AuditOutboxRow[]>(
        `SELECT id, actor_id, actor_email, role, action, entity_type, entity_id,
                merchant_id, approval_request_id, request_id, client_ip,
                user_agent, before_json, after_json, created_at
         FROM audit_outbox
         WHERE shipped_at IS NULL
         ORDER BY created_at ASC, id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        batchSize,
      ),
    );

    if (rows.length === 0) {
      return 0;
    }

    await this.auditStore.appendBatch(
      rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        actorId: row.actor_id,
        actorEmail: row.actor_email,
        role: row.role,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        merchantId: row.merchant_id,
        approvalRequestId: row.approval_request_id,
        requestId: row.request_id,
        clientIp: row.client_ip,
        userAgent: row.user_agent,
        beforeJson: asRecord(row.before_json),
        afterJson: asRecord(row.after_json),
      })),
    );

    const ids = rows.map((row) => row.id);
    await this.db.$executeRawUnsafe(
      `UPDATE audit_outbox SET shipped_at = now() WHERE id = ANY($1::uuid[])`,
      ids,
    );
    return rows.length;
  }
}

export const verifyRestoredAuditChain = (
  auditStore: DedicatedAuditDatabaseDriver,
  limit?: number,
): Promise<{ verifiedCount: number; valid: boolean; firstBrokenId?: string }> =>
  auditStore.verifyHashChainIntegrity(limit);

export type { AuditHashInput };
export { computeAuditRowHash };
