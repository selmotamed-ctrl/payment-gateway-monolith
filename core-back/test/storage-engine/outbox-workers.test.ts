import { expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  OutboxRelayWorker,
  projectAttemptTransition,
} from "../../lib/storageEngine/outboxWorkers";
import type { OutboxEnvelope } from "../../lib/storageEngine/ports";
import {
  createWorkerSandbox,
  databaseIsReachable,
  describeDatabase,
  uniqueId,
  uniqueUuid,
  type WorkerSandbox,
} from "./helpers/db";

if (!databaseIsReachable) {
  test.skip("outbox worker suite requires the live database", () => undefined);
}

interface EventInput {
  aggregateId: string;
  topic?: OutboxEnvelope["topic"];
  merchantId?: string | null;
  payload: unknown;
}

/**
 * Prisma model queries always target the public schema, so the isolated
 * worker sandbox is populated with raw SQL against its search_path.
 */
const insertEvents = async (
  sandbox: WorkerSandbox,
  events: EventInput[],
): Promise<void> => {
  for (const event of events) {
    await sandbox.client.$executeRawUnsafe(
      `INSERT INTO outbox_events
         (topic, aggregate_type, aggregate_id, merchant_id, payload_json)
       VALUES ($1, $2, $3, $4::uuid, $5::jsonb)`,
      event.topic ?? "attempt.transitioned",
      "payment_attempt",
      event.aggregateId,
      event.merchantId ?? null,
      JSON.stringify(event.payload),
    );
  }
};

const unprocessedCount = async (sandbox: WorkerSandbox): Promise<number> => {
  const rows = await sandbox.client.$queryRawUnsafe<Array<{ count: string }>>(
    "SELECT count(*)::text AS count FROM outbox_events WHERE processed_at IS NULL",
  );
  return Number(rows[0]?.count ?? "0");
};

const processedAtFor = async (
  sandbox: WorkerSandbox,
  aggregateId: string,
): Promise<Date | null> => {
  const rows = await sandbox.client.$queryRawUnsafe<Array<{ processed_at: Date | null }>>(
    "SELECT processed_at FROM outbox_events WHERE aggregate_id = $1",
    aggregateId,
  );
  return rows[0]?.processed_at ?? null;
};

describeDatabase("OutboxRelayWorker (live PostgreSQL)", () => {
  test("four concurrent relay instances process each event exactly once", async () => {
    const sandbox = await createWorkerSandbox("outbox-relay");
    const prefix = uniqueId("outbox-relay");
    try {
      const events: EventInput[] = Array.from({ length: 26 }, (_, index) => ({
        aggregateId: `${prefix}-marker-${index}`,
        topic: "config.invalidated",
        payload: { index },
      }));
      await insertEvents(sandbox, events);

      const processedMarkers: string[] = [];
      const workers = Array.from({ length: 4 }, () =>
        new OutboxRelayWorker(sandbox.newClient({ max: 4 }), {
          batchSize: 10,
          handlers: {
            "config.invalidated": async (event) => {
              processedMarkers.push(event.aggregateId);
            },
          },
        }),
      );

      const drained = await Promise.all(workers.map((worker) => worker.drain()));
      expect(drained.reduce((sum, count) => sum + count, 0)).toBe(26);
      expect(processedMarkers).toHaveLength(26);
      expect(new Set(processedMarkers).size).toBe(26);
      expect(await unprocessedCount(sandbox)).toBe(0);

      const rerun = await Promise.all(workers.map((worker) => worker.drain()));
      expect(rerun.reduce((sum, count) => sum + count, 0)).toBe(0);
      expect(processedMarkers).toHaveLength(26);
    } finally {
      await sandbox.cleanup();
    }
  });

  test("read-model projection is correct for success/failure/open statuses", async () => {
    const sandbox = await createWorkerSandbox("outbox-read-models");
    const merchantId = uniqueUuid();
    const routeId = uniqueUuid();
    const day = "2026-11-03";
    const attempts = [
      { status: "SUCCEEDED", amount: "100.0000", net: "90.0000" },
      { status: "FAILED", amount: "50.0000", net: "0.0000" },
      { status: "EXPIRED", amount: "40.0000", net: "0.0000" },
      { status: "CANCELLED", amount: "30.0000", net: "0.0000" },
      { status: "AWAITING_CUSTOMER", amount: "20.0000", net: "10.0000" },
      { status: "UNKNOWN", amount: "10.0000", net: "5.0000" },
    ];
    // Production bug workaround: projectAttemptTransition passes one array as
    // the bind arguments of $executeRawUnsafe (outboxWorkers.ts:86-96 and
    // 102-112), while Prisma expects varargs. The proxy spreads the array so
    // the projection logic itself can be verified against real PostgreSQL.
    const normalizingClient = new Proxy(sandbox.client, {
      get(target, property) {
        if (property === "$executeRawUnsafe") {
          return (query: string, ...args: unknown[]): Promise<number> =>
            target.$executeRawUnsafe(
              query,
              ...(args.length === 1 && Array.isArray(args[0])
                ? (args[0] as unknown[])
                : args),
            );
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PrismaClient;

    try {
      for (const [index, attempt] of attempts.entries()) {
        await projectAttemptTransition(
          {
            topic: "attempt.transitioned",
            aggregateType: "payment_attempt",
            aggregateId: `projection-${index}`,
            merchantId,
            payload: {
              merchantId,
              routeId,
              currency: "LYD",
              status: attempt.status,
              occurredAt: `${day}T10:00:00.000Z`,
              totalChargedAmount: attempt.amount,
              netMerchantAmount: attempt.net,
            },
          },
          normalizingClient,
        );
      }

      const merchantRows = await sandbox.client.$queryRawUnsafe<
        Array<{
          attempt_count: number;
          success_count: number;
          failure_count: number;
          gross_amount: string;
          net_amount: string;
        }>
      >(
        `SELECT attempt_count, success_count, failure_count,
                gross_amount::text AS gross_amount, net_amount::text AS net_amount
         FROM rm_merchant_daily_stats
         WHERE merchant_id = $1::uuid AND day = $2::date AND currency = $3`,
        merchantId,
        day,
        "LYD",
      );
      expect(merchantRows).toHaveLength(1);
      expect(merchantRows[0]?.attempt_count).toBe(6);
      expect(merchantRows[0]?.success_count).toBe(1);
      expect(merchantRows[0]?.failure_count).toBe(3);
      expect(new Decimal(merchantRows[0]?.gross_amount ?? "0").toFixed(4)).toBe("250.0000");
      expect(new Decimal(merchantRows[0]?.net_amount ?? "0").toFixed(4)).toBe("105.0000");

      const routeRows = await sandbox.client.$queryRawUnsafe<
        Array<{ attempt_count: number; success_count: number; volume_amount: string }>
      >(
        `SELECT attempt_count, success_count, volume_amount::text AS volume_amount
         FROM rm_route_daily_volumes
         WHERE route_id = $1::uuid AND day = $2::date AND currency = $3`,
        routeId,
        day,
        "LYD",
      );
      expect(routeRows).toHaveLength(1);
      expect(routeRows[0]?.attempt_count).toBe(6);
      expect(routeRows[0]?.success_count).toBe(1);
      expect(new Decimal(routeRows[0]?.volume_amount ?? "0").toFixed(4)).toBe("100.0000");
    } finally {
      await sandbox.cleanup();
    }
  });

  test("the default attempt.transitioned handler projects the read model atomically", async () => {
    const sandbox = await createWorkerSandbox("outbox-attempt-bug");
    const prefix = uniqueId("outbox-attempt-bug");
    const aggregateId = `${prefix}-event`;
    const merchantId = uniqueUuid();
    const routeId = uniqueUuid();
    try {
      await insertEvents(sandbox, [
        {
          aggregateId,
          topic: "attempt.transitioned",
          merchantId,
          payload: {
            merchantId,
            routeId,
            status: "SUCCEEDED",
            occurredAt: "2026-11-03T10:00:00.000Z",
            totalChargedAmount: "10.0000",
            netMerchantAmount: "9.0000",
            currency: "LYD",
          },
        },
      ]);
      const worker = new OutboxRelayWorker(sandbox.client, { batchSize: 10 });
      expect(await worker.drain()).toBe(1);
      expect(await processedAtFor(sandbox, aggregateId)).not.toBeNull();
      expect(await unprocessedCount(sandbox)).toBe(0);

      const merchantRows = await sandbox.client.$queryRawUnsafe<Array<{ attempt_count: number; gross_amount: string }>>(
        `SELECT attempt_count, gross_amount FROM rm_merchant_daily_stats WHERE merchant_id = $1::uuid`,
        merchantId,
      );
      expect(merchantRows[0]?.attempt_count).toBe(1);
      expect(new Decimal(merchantRows[0]?.gross_amount ?? "0").toFixed(4)).toBe("10.0000");
      const routeRows = await sandbox.client.$queryRawUnsafe<Array<{ attempt_count: number }>>(
        `SELECT attempt_count FROM rm_route_daily_volumes WHERE route_id = $1::uuid`,
        routeId,
      );
      expect(routeRows[0]?.attempt_count).toBe(1);
    } finally {
      await sandbox.cleanup();
    }
  });

  test("malformed payloads do not wedge the queue", async () => {
    const sandbox = await createWorkerSandbox("outbox-malformed");
    const prefix = uniqueId("outbox-malformed");
    const stringAggregate = `${prefix}-string`;
    const arrayAggregate = `${prefix}-array`;
    try {
      await insertEvents(sandbox, [
        {
          aggregateId: stringAggregate,
          topic: "attempt.transitioned",
          payload: "not-json",
        },
        {
          aggregateId: arrayAggregate,
          topic: "attempt.transitioned",
          payload: [1, 2, 3],
        },
      ]);
      const worker = new OutboxRelayWorker(sandbox.client, { batchSize: 10 });
      expect(await worker.drain()).toBe(2);
      expect(await unprocessedCount(sandbox)).toBe(0);
      expect(await processedAtFor(sandbox, stringAggregate)).not.toBeNull();
      expect(await processedAtFor(sandbox, arrayAggregate)).not.toBeNull();
    } finally {
      await sandbox.cleanup();
    }
  });

  test("a throwing handler rolls its savepoint back and leaves the event unprocessed with one attempt", async () => {
    const sandbox = await createWorkerSandbox("outbox-handler");
    const prefix = uniqueId("outbox-handler-failure");
    const aggregateId = `${prefix}-event`;
    try {
      await insertEvents(sandbox, [
        { aggregateId, topic: "config.invalidated", payload: { index: 1 } },
      ]);
      const failing = new OutboxRelayWorker(sandbox.client, {
        batchSize: 10,
        handlers: {
          "config.invalidated": async () => {
            throw new Error("HANDLER_FAILED");
          },
        },
      });
      // AUTO-02: a consumer error no longer aborts the drain; the event is
      // retried alone, its attempt is counted and it stays pending.
      expect(await failing.drain()).toBe(0);
      expect(await processedAtFor(sandbox, aggregateId)).toBeNull();
      const [state] = await sandbox.client.$queryRawUnsafe<Array<{ attempts: number; last_error: string | null }>>(
        "SELECT attempts, last_error FROM outbox_events WHERE aggregate_id = $1",
        aggregateId,
      );
      expect(Number(state?.attempts)).toBe(1);
      expect(state?.last_error).toBe("HANDLER_FAILED");

      const succeeding = new OutboxRelayWorker(sandbox.client, { batchSize: 10 });
      expect(await succeeding.drain()).toBe(1);
      expect(await processedAtFor(sandbox, aggregateId)).not.toBeNull();
    } finally {
      await sandbox.cleanup();
    }
  });

  test("FOR UPDATE SKIP LOCKED lets only the first of two concurrent workers claim a batch", async () => {
    const sandbox = await createWorkerSandbox("outbox-skip-locked");
    const prefix = uniqueId("outbox-skip-locked");
    const firstAggregate = `${prefix}-a`;
    const secondAggregate = `${prefix}-b`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      await insertEvents(sandbox, [
        { aggregateId: firstAggregate, topic: "config.invalidated", payload: {} },
        { aggregateId: secondAggregate, topic: "config.invalidated", payload: {} },
      ]);

      const slowWorker = new OutboxRelayWorker(sandbox.newClient({ max: 4 }), {
        batchSize: 10,
        handlers: {
          "config.invalidated": async () => {
            entered();
            await gate;
          },
        },
      });
      const fastWorker = new OutboxRelayWorker(sandbox.newClient({ max: 4 }), {
        batchSize: 10,
      });

      const slowDrain = slowWorker.drain();
      await enteredPromise;
      const fastCount = await fastWorker.drain();
      expect(fastCount).toBe(0);
      release();
      expect(await slowDrain).toBe(2);
      expect(await unprocessedCount(sandbox)).toBe(0);
    } finally {
      release();
      await sandbox.cleanup();
    }
  });
});
