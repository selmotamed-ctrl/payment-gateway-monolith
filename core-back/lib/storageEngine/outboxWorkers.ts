import { Decimal } from "decimal.js";
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

/**
 * Parses an outbox money value with decimal.js. Never use `Number` for money:
 * the previous implementation went through `Number(value).toFixed(4)`, which
 * loses precision for amounts above 2^53 / 10^4 and rounds binary fractions.
 */
const asMoney = (value: unknown): Decimal => {
  if (value === null || value === undefined || value === "") {
    return new Decimal(0);
  }
  try {
    const parsed = new Decimal(
      typeof value === "object" && value !== null && "toString" in value
        ? String((value as { toString(): string }).toString())
        : (value as Decimal.Value),
    );
    return parsed.isFinite() ? parsed : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
};

const dayOf = (value: unknown, fallback: Date): string => {
  const text = typeof value === "string" ? value : null;
  if (text && /^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }
  return Number.isNaN(fallback.getTime())
    ? new Date().toISOString().slice(0, 10)
    : fallback.toISOString().slice(0, 10);
};

export const attemptStatusKind = (status: string | null): "success" | "failure" | "open" => {
  if (status === "SUCCEEDED") {
    return "success";
  }
  if (status === "FAILED" || status === "EXPIRED" || status === "CANCELLED" || status === "BLOCKED") {
    return "failure";
  }
  return "open";
};

export type OutboxHandler = (
  event: OutboxEnvelope,
  tx: PrismaClient,
) => Promise<void>;

/**
 * A handler that receives every claimed event of its topic at once. Batch
 * handlers must be commutative over the events of one batch (the relay does
 * not interleave them with per-event handlers in id order).
 */
export type OutboxBatchHandler = (
  events: OutboxEnvelope[],
  tx: PrismaClient,
) => Promise<void>;

export interface MerchantDailyDelta {
  merchantId: string;
  day: string;
  currency: string;
  attemptCount: number;
  successCount: number;
  failureCount: number;
  grossAmount: Decimal;
  netAmount: Decimal;
  successAmount: Decimal;
  successNetAmount: Decimal;
}

export interface RouteDailyDelta {
  routeId: string;
  day: string;
  currency: string;
  attemptCount: number;
  successCount: number;
  /** Volume of the attempts that SUCCEEDED (the daily route cap semantics). */
  volumeAmount: Decimal;
}

export interface AttemptReadModelDeltas {
  merchants: MerchantDailyDelta[];
  routes: RouteDailyDelta[];
}

/**
 * Folds a batch of `attempt.transitioned` events into one delta per read-model
 * key. Pure (no I/O) so it is unit-tested without a database. Sorting the keys
 * makes concurrent relays lock the read-model rows in the same order.
 *
 * Semantics:
 * - a `created` event (or a legacy event without the marker) adds one
 *   attempt and its gross/net amounts to the creation day;
 * - a terminal SUCCEEDED event adds one success and the success gross/net
 *   amounts to the day of the transition (for routes: the route volume, which
 *   is the succeeded volume, matching the daily route cap);
 * - a terminal FAILED/EXPIRED/CANCELLED/BLOCKED event adds one failure.
 */
export const aggregateAttemptTransitions = (
  events: readonly OutboxEnvelope[],
): AttemptReadModelDeltas => {
  const merchants = new Map<string, MerchantDailyDelta>();
  const routes = new Map<string, RouteDailyDelta>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    const merchantId = asString(payload.merchantId) ?? event.merchantId ?? null;
    const routeId = asString(payload.routeId);
    const currency = (asString(payload.currency) ?? "LYD").slice(0, 3);
    const kind = attemptStatusKind(asString(payload.status));
    const occurredAt = payload.occurredAt ? new Date(String(payload.occurredAt)) : new Date();
    const day = dayOf(payload.occurredAt, occurredAt);
    const amount = asMoney(payload.totalChargedAmount);
    const net = asMoney(payload.netMerchantAmount);
    const created = (asString(payload.event) ?? "created") === "created";
    const success = kind === "success";
    const failure = kind === "failure";
    if (!created && !success && !failure) {
      continue;
    }
    if (merchantId) {
      const key = `${merchantId}|${day}|${currency}`;
      const row = merchants.get(key) ?? {
        merchantId,
        day,
        currency,
        attemptCount: 0,
        successCount: 0,
        failureCount: 0,
        grossAmount: new Decimal(0),
        netAmount: new Decimal(0),
        successAmount: new Decimal(0),
        successNetAmount: new Decimal(0),
      };
      if (created) {
        row.attemptCount += 1;
        row.grossAmount = row.grossAmount.plus(amount);
        row.netAmount = row.netAmount.plus(net);
      }
      if (success) {
        row.successCount += 1;
        row.successAmount = row.successAmount.plus(amount);
        row.successNetAmount = row.successNetAmount.plus(net);
      }
      if (failure) {
        row.failureCount += 1;
      }
      merchants.set(key, row);
    }
    if (routeId) {
      const key = `${routeId}|${day}|${currency}`;
      const row = routes.get(key) ?? {
        routeId,
        day,
        currency,
        attemptCount: 0,
        successCount: 0,
        volumeAmount: new Decimal(0),
      };
      if (created) {
        row.attemptCount += 1;
      }
      if (success) {
        row.successCount += 1;
        row.volumeAmount = row.volumeAmount.plus(amount);
      }
      routes.set(key, row);
    }
  }
  const byKey = <T>(map: Map<string, T>): T[] =>
    [...map.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, value]) => value);
  return { merchants: byKey(merchants), routes: byKey(routes) };
};

const money4 = (value: Decimal): string => value.toFixed(4);

/**
 * Applies the folded deltas with ONE `INSERT ... SELECT FROM unnest(...) ON
 * CONFLICT DO UPDATE` per read model, instead of two upserts per event.
 */
export const applyAttemptReadModelDeltas = async (
  db: PrismaClient,
  deltas: AttemptReadModelDeltas,
): Promise<void> => {
  if (deltas.merchants.length > 0) {
    const rows = deltas.merchants;
    await db.$executeRawUnsafe(
      `INSERT INTO rm_merchant_daily_stats
         (merchant_id, day, currency, attempt_count, success_count, failure_count,
          gross_amount, net_amount, success_amount, success_net_amount, updated_at)
       SELECT t.merchant_id, t.day, t.currency, t.attempt_count, t.success_count, t.failure_count,
              t.gross_amount, t.net_amount, t.success_amount, t.success_net_amount, now()
       FROM unnest($1::uuid[], $2::date[], $3::text[], $4::int[], $5::int[], $6::int[],
                   $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[])
         AS t(merchant_id, day, currency, attempt_count, success_count, failure_count,
              gross_amount, net_amount, success_amount, success_net_amount)
       ORDER BY t.merchant_id, t.day, t.currency
       ON CONFLICT (merchant_id, day, currency) DO UPDATE SET
         attempt_count = rm_merchant_daily_stats.attempt_count + EXCLUDED.attempt_count,
         success_count = rm_merchant_daily_stats.success_count + EXCLUDED.success_count,
         failure_count = rm_merchant_daily_stats.failure_count + EXCLUDED.failure_count,
         gross_amount = rm_merchant_daily_stats.gross_amount + EXCLUDED.gross_amount,
         net_amount = rm_merchant_daily_stats.net_amount + EXCLUDED.net_amount,
         success_amount = rm_merchant_daily_stats.success_amount + EXCLUDED.success_amount,
         success_net_amount = rm_merchant_daily_stats.success_net_amount + EXCLUDED.success_net_amount,
         updated_at = now()`,
      rows.map((row) => row.merchantId),
      rows.map((row) => row.day),
      rows.map((row) => row.currency),
      rows.map((row) => row.attemptCount),
      rows.map((row) => row.successCount),
      rows.map((row) => row.failureCount),
      rows.map((row) => money4(row.grossAmount)),
      rows.map((row) => money4(row.netAmount)),
      rows.map((row) => money4(row.successAmount)),
      rows.map((row) => money4(row.successNetAmount)),
    );
  }
  if (deltas.routes.length > 0) {
    const rows = deltas.routes;
    await db.$executeRawUnsafe(
      `INSERT INTO rm_route_daily_volumes
         (route_id, day, currency, attempt_count, success_count, volume_amount, updated_at)
       SELECT t.route_id, t.day, t.currency, t.attempt_count, t.success_count, t.volume_amount, now()
       FROM unnest($1::uuid[], $2::date[], $3::text[], $4::int[], $5::int[], $6::numeric[])
         AS t(route_id, day, currency, attempt_count, success_count, volume_amount)
       ORDER BY t.route_id, t.day, t.currency
       ON CONFLICT (route_id, day, currency) DO UPDATE SET
         attempt_count = rm_route_daily_volumes.attempt_count + EXCLUDED.attempt_count,
         success_count = rm_route_daily_volumes.success_count + EXCLUDED.success_count,
         volume_amount = rm_route_daily_volumes.volume_amount + EXCLUDED.volume_amount,
         updated_at = now()`,
      rows.map((row) => row.routeId),
      rows.map((row) => row.day),
      rows.map((row) => row.currency),
      rows.map((row) => row.attemptCount),
      rows.map((row) => row.successCount),
      rows.map((row) => money4(row.volumeAmount)),
    );
  }
};

export const projectAttemptTransitions: OutboxBatchHandler = async (events, db) =>
  applyAttemptReadModelDeltas(db, aggregateAttemptTransitions(events));

/** Single-event projection kept for callers/tests that project one event. */
export const projectAttemptTransition = async (
  event: OutboxEnvelope,
  db: PrismaClient,
): Promise<void> => projectAttemptTransitions([event], db);

/**
 * Rebuilds both attempt read models from `payment_attempts` for a UTC day
 * range (inclusive). Used after bulk loads (synthetic seeder, restores) that
 * insert attempts without outbox events. Creation volume is bucketed by
 * `created_at`, outcomes by `COALESCE(terminal_at, updated_at)` of the CURRENT
 * status, so an attempt that went SUCCEEDED -> REFUNDED is not counted as a
 * success by a rebuild (the incremental projection did count it).
 */
export const rebuildAttemptReadModels = async (
  db: PrismaClient,
  range: { fromDay: string; toDay: string },
): Promise<void> => {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `DELETE FROM rm_merchant_daily_stats WHERE day BETWEEN $1::date AND $2::date`,
      range.fromDay,
      range.toDay,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM rm_route_daily_volumes WHERE day BETWEEN $1::date AND $2::date`,
      range.fromDay,
      range.toDay,
    );
    const facts = `
      WITH facts AS (
        SELECT merchant_id, route_id, currency, (created_at)::date AS day,
               1 AS attempt_count, 0 AS success_count, 0 AS failure_count,
               total_charged_amount AS gross_amount, net_merchant_amount AS net_amount,
               0::numeric AS success_amount, 0::numeric AS success_net_amount
        FROM payment_attempts
        WHERE created_at >= $1::date AND created_at < ($2::date + 1)
        UNION ALL
        SELECT merchant_id, route_id, currency, (COALESCE(terminal_at, updated_at))::date AS day,
               0, CASE WHEN status = 'SUCCEEDED' THEN 1 ELSE 0 END,
               CASE WHEN status IN ('FAILED', 'EXPIRED', 'CANCELLED', 'BLOCKED') THEN 1 ELSE 0 END,
               0, 0,
               CASE WHEN status = 'SUCCEEDED' THEN total_charged_amount ELSE 0 END,
               CASE WHEN status = 'SUCCEEDED' THEN net_merchant_amount ELSE 0 END
        FROM payment_attempts
        WHERE status IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'BLOCKED')
          AND COALESCE(terminal_at, updated_at) >= $1::date
          AND COALESCE(terminal_at, updated_at) < ($2::date + 1)
      )`;
    await tx.$executeRawUnsafe(
      `${facts}
       INSERT INTO rm_merchant_daily_stats
         (merchant_id, day, currency, attempt_count, success_count, failure_count,
          gross_amount, net_amount, success_amount, success_net_amount, updated_at)
       SELECT merchant_id, day, currency, SUM(attempt_count), SUM(success_count), SUM(failure_count),
              SUM(gross_amount), SUM(net_amount), SUM(success_amount), SUM(success_net_amount), now()
       FROM facts GROUP BY merchant_id, day, currency`,
      range.fromDay,
      range.toDay,
    );
    await tx.$executeRawUnsafe(
      `${facts}
       INSERT INTO rm_route_daily_volumes
         (route_id, day, currency, attempt_count, success_count, volume_amount, updated_at)
       SELECT route_id, day, currency, SUM(attempt_count), SUM(success_count), SUM(success_amount), now()
       FROM facts GROUP BY route_id, day, currency`,
      range.fromDay,
      range.toDay,
    );
  }, { timeout: 600_000, maxWait: 10_000 });
};

export interface OutboxRetentionOptions {
  /** Processed rows older than this are deleted. 0 disables pruning. */
  retentionMs?: number;
  /** Rows deleted per prune statement. */
  pruneBatchSize?: number;
  /** Minimum time between two prune passes of one worker. */
  pruneIntervalMs?: number;
}

/**
 * Poll scheduling shared by the relay and the shipper: a full batch drains
 * again immediately, an empty poll backs off exponentially up to `maxIdleMs`
 * so an idle node does not open a transaction every 250 ms forever.
 */
export const nextPollDelayMs = (
  drained: number,
  batchSize: number,
  previousDelayMs: number,
  baseMs: number,
  maxIdleMs: number,
): number => {
  if (drained >= batchSize) {
    return 0;
  }
  if (drained > 0) {
    return baseMs;
  }
  const grown = previousDelayMs <= 0 ? baseMs : previousDelayMs * 2;
  return Math.min(Math.max(baseMs, maxIdleMs), Math.max(baseMs, grown));
};

export class OutboxRelayWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private delayMs = 0;
  private lastPruneAt = 0;
  private readonly handlers: Record<string, OutboxHandler>;
  private readonly batchHandlers: Record<string, OutboxBatchHandler>;

  constructor(
    private readonly db: PrismaClient,
    private readonly options: {
      intervalMs?: number;
      maxIdleIntervalMs?: number;
      batchSize?: number;
      handlers?: Record<string, OutboxHandler>;
      batchHandlers?: Record<string, OutboxBatchHandler>;
      retention?: OutboxRetentionOptions;
      logger?: WorkerLoggerLike;
    } = {},
  ) {
    // Topics without a consumer are acknowledged without work. A per-event
    // handler registered by the caller overrides the batch handler of the
    // same topic.
    this.handlers = {
      "ledger.entry_posted": async () => undefined,
      "merchant.updated": async () => undefined,
      "kyb.document_uploaded": async () => undefined,
      "reconciliation.completed": async () => undefined,
      "config.invalidated": async () => undefined,
      ...options.handlers,
    };
    this.batchHandlers = {
      "attempt.transitioned": projectAttemptTransitions,
      ...options.batchHandlers,
    };
    for (const topic of Object.keys(options.handlers ?? {})) {
      delete this.batchHandlers[topic];
    }
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

  /** Cuts an idle back-off short (e.g. after a local commit). */
  public wake(): void {
    if (this.running && this.delayMs > (this.options.intervalMs ?? 250)) {
      this.delayMs = 0;
      this.schedule(0);
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
    const baseMs = this.options.intervalMs ?? 250;
    let drained = 0;
    try {
      drained = await this.drain();
      await this.pruneIfDue();
    } catch (error) {
      this.options.logger?.error?.("outbox relay failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.delayMs = nextPollDelayMs(
        drained,
        this.options.batchSize ?? 100,
        this.delayMs,
        baseMs,
        this.options.maxIdleIntervalMs ?? 2_000,
      );
      this.schedule(this.delayMs);
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

      const batched = new Map<string, OutboxEnvelope[]>();
      for (const row of rows) {
        const event: OutboxEnvelope = {
          topic: row.topic as OutboxEnvelope["topic"],
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          merchantId: row.merchant_id,
          payload: asRecord(row.payload_json),
        };
        if (this.batchHandlers[event.topic]) {
          const list = batched.get(event.topic) ?? [];
          list.push(event);
          batched.set(event.topic, list);
          continue;
        }
        const handler = this.handlers[event.topic];
        if (handler) {
          await handler(event, tx as unknown as PrismaClient);
        }
      }
      for (const [topic, events] of batched) {
        await this.batchHandlers[topic]!(events, tx as unknown as PrismaClient);
      }
      // One acknowledgement statement per batch instead of one per row.
      await tx.$executeRawUnsafe(
        `UPDATE outbox_events SET processed_at = now() WHERE id = ANY($1::bigint[])`,
        rows.map((row) => String(row.id)),
      );
      return rows.length;
    });
  }

  private async pruneIfDue(): Promise<void> {
    const retentionMs = this.options.retention?.retentionMs ?? 0;
    const intervalMs = this.options.retention?.pruneIntervalMs ?? 60_000;
    if (retentionMs <= 0 || Date.now() - this.lastPruneAt < intervalMs) {
      return;
    }
    this.lastPruneAt = Date.now();
    await this.prune();
  }

  /**
   * Deletes processed rows older than the retention window, oldest first, in
   * bounded batches. It walks the primary key below the oldest unprocessed id
   * (found through the partial unprocessed index), so it needs no extra index
   * on `processed_at` and never touches pending work.
   */
  public async prune(now: Date = new Date()): Promise<number> {
    const retentionMs = this.options.retention?.retentionMs ?? 0;
    if (retentionMs <= 0) {
      return 0;
    }
    const batch = this.options.retention?.pruneBatchSize ?? 5_000;
    const cutoff = new Date(now.getTime() - retentionMs);
    return this.db.$executeRawUnsafe(
      `DELETE FROM outbox_events
       WHERE id IN (
         SELECT id FROM outbox_events
         WHERE id < COALESCE((SELECT min(id) FROM outbox_events WHERE processed_at IS NULL), 9223372036854775807)
           AND processed_at IS NOT NULL
           AND processed_at < $1::timestamptz
         ORDER BY id ASC
         LIMIT $2
       )`,
      cutoff,
      batch,
    );
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
  private delayMs = 0;
  private lastPruneAt = 0;

  constructor(
    private readonly db: PrismaClient,
    private readonly auditStore: DedicatedAuditDatabaseDriver,
    private readonly options: {
      intervalMs?: number;
      maxIdleIntervalMs?: number;
      batchSize?: number;
      /** How long a claimed batch is reserved for this shipper. */
      leaseMs?: number;
      retention?: OutboxRetentionOptions;
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
    const baseMs = this.options.intervalMs ?? 500;
    let drained = 0;
    try {
      drained = await this.drain();
      await this.pruneIfDue();
    } catch (error) {
      this.options.logger?.error?.("audit shipper failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.delayMs = nextPollDelayMs(
        drained,
        this.options.batchSize ?? 100,
        this.delayMs,
        baseMs,
        this.options.maxIdleIntervalMs ?? 5_000,
      );
      this.schedule(this.delayMs);
    }
  }

  public async drain(): Promise<number> {
    const batchSize = this.options.batchSize ?? 100;
    const leaseMs = Math.max(1_000, this.options.leaseMs ?? 30_000);
    // Claim with a lease in ONE statement. The previous implementation
    // selected FOR UPDATE SKIP LOCKED inside a transaction that committed
    // before the append, so the row locks were already released while the
    // batch was being shipped and a second shipper could claim and append the
    // same rows (harmless thanks to the idempotent append, but double work and
    // a racy "exactly once" count). The lease keeps the batch reserved until
    // it is acknowledged or the lease expires after a crash.
    const claimed = await this.db.$queryRawUnsafe<AuditOutboxRow[]>(
      `UPDATE audit_outbox AS a
       SET lease_until = now() + ($2::int * interval '1 millisecond')
       WHERE a.id IN (
         SELECT id FROM audit_outbox
         WHERE shipped_at IS NULL
           AND (lease_until IS NULL OR lease_until < now())
         ORDER BY created_at ASC, id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING a.id, a.actor_id, a.actor_email, a.role, a.action, a.entity_type, a.entity_id,
                 a.merchant_id, a.approval_request_id, a.request_id, a.client_ip,
                 a.user_agent, a.before_json, a.after_json, a.created_at`,
      batchSize,
      leaseMs,
    );

    if (claimed.length === 0) {
      return 0;
    }
    // UPDATE ... RETURNING does not preserve the sub-select order.
    const rows = [...claimed].sort((left, right) => {
      const delta = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
      return delta !== 0 ? delta : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

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
      `UPDATE audit_outbox SET shipped_at = now(), lease_until = NULL WHERE id = ANY($1::uuid[])`,
      ids,
    );
    return rows.length;
  }

  private async pruneIfDue(): Promise<void> {
    const retentionMs = this.options.retention?.retentionMs ?? 0;
    const intervalMs = this.options.retention?.pruneIntervalMs ?? 60_000;
    if (retentionMs <= 0 || Date.now() - this.lastPruneAt < intervalMs) {
      return;
    }
    this.lastPruneAt = Date.now();
    await this.prune();
  }

  /**
   * Deletes rows that were shipped to the dedicated audit database more than
   * the retention window ago. The dedicated database is the durable copy;
   * `audit_log` keeps the compatibility copy on the primary.
   */
  public async prune(now: Date = new Date()): Promise<number> {
    const retentionMs = this.options.retention?.retentionMs ?? 0;
    if (retentionMs <= 0) {
      return 0;
    }
    const batch = this.options.retention?.pruneBatchSize ?? 5_000;
    const cutoff = new Date(now.getTime() - retentionMs);
    return this.db.$executeRawUnsafe(
      `DELETE FROM audit_outbox
       WHERE id IN (
         SELECT id FROM audit_outbox
         WHERE shipped_at IS NOT NULL AND shipped_at < $1::timestamptz
         ORDER BY shipped_at ASC
         LIMIT $2
       )`,
      cutoff,
      batch,
    );
  }
}

export const verifyRestoredAuditChain = (
  auditStore: DedicatedAuditDatabaseDriver,
  limit?: number,
): Promise<{ verifiedCount: number; valid: boolean; firstBrokenId?: string }> =>
  auditStore.verifyHashChainIntegrity(limit);

export type { AuditHashInput };
export { computeAuditRowHash };
