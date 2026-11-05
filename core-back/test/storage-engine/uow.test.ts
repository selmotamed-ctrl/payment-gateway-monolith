import { afterAll, expect, test } from "bun:test";
import { Prisma } from "../../generated/prisma/client";
import type { PrismaClient } from "../../generated/prisma/client";
import { PostgresUnitOfWorkAdapter } from "../../lib/storageEngine/uowAdapter";
import {
  cleanupLedger,
  createPrisma,
  databaseIsReachable,
  describeDatabase,
  seedGlAccount,
  uniqueId,
  uniqueUuid,
} from "./helpers/db";
import { withLedgerMaintenance } from "../helpers/ledgerMaintenance";

const client: PrismaClient = createPrisma({ max: 35 });
const uow = new PostgresUnitOfWorkAdapter(client);

const cleanupRefs = async (refPrefix: string): Promise<void> => {
  await withLedgerMaintenance(client, (tx) =>
    tx.journalEntry.deleteMany({ where: { refId: { startsWith: refPrefix } } }),
  );
  await client.outboxEvent.deleteMany({ where: { aggregateId: { startsWith: refPrefix } } });
  await client.auditOutbox.deleteMany({ where: { entityId: { startsWith: refPrefix } } });
};

afterAll(async () => {
  await client.$disconnect().catch(() => undefined);
});

if (!databaseIsReachable) {
  test.skip("PostgreSQL unit-of-work suite requires the live database", () => undefined);
}

describeDatabase("PostgresUnitOfWorkAdapter (live PostgreSQL)", () => {
  test("commits ledger, outbox and audit rows atomically and reports the commit LSN", async () => {
    const refId = uniqueId("uow-commit");
    const aggregateId = uniqueId("uow-outbox");
    const actorId = uniqueUuid();
    let auditId = "";

    const result = await uow.run(async (tx) => {
      await tx.db.journalEntry.create({
        data: {
          refType: "PAYMENT_ATTEMPT",
          refId,
          description: "uow atomicity",
        },
      });
      await tx.outbox.enqueue({
        topic: "config.invalidated",
        aggregateType: "uow_test",
        aggregateId,
        payload: { refId, nested: { safe: true } },
      });
      auditId = await tx.audit.record({
        actorId,
        role: "SECURITY_ADMIN",
        action: "UOW_TEST",
        entityType: "UOW",
        entityId: refId,
        beforeJson: { a: 1 },
        afterJson: { a: 2, b: [1, 2, 3] },
      });
      return { refId, auditId };
    });

    expect(result.data.refId).toBe(refId);
    expect(result.data.auditId).toBe(auditId);
    expect(result.commitLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/i);
    expect(result.commitLsn).not.toBe("0/0");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.durationMs)).toBe(true);

    const entry = await client.journalEntry.findUnique({
      where: { refType_refId: { refType: "PAYMENT_ATTEMPT", refId } },
    });
    expect(entry).not.toBeNull();
    const outbox = await client.outboxEvent.findFirst({ where: { aggregateId } });
    expect(outbox).not.toBeNull();
    expect(outbox?.payloadJson).toMatchObject({ refId, nested: { safe: true } });
    const audit = await client.auditOutbox.findUnique({ where: { id: auditId } });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(actorId);
    expect(audit?.afterJson).toMatchObject({ a: 2, b: [1, 2, 3] });

    await cleanupRefs(refId);
    await cleanupRefs(aggregateId);
  });

  test("rolls back every row when the callback throws", async () => {
    const refId = uniqueId("uow-rollback");
    const aggregateId = uniqueId("uow-rollback-outbox");
    const actorId = uniqueUuid();

    await expect(
      uow.run(async (tx) => {
        await tx.db.journalEntry.create({
          data: {
            refType: "PAYMENT_ATTEMPT",
            refId,
            description: "uow rollback",
          },
        });
        await tx.outbox.enqueueMany([
          {
            topic: "config.invalidated",
            aggregateType: "uow_test",
            aggregateId,
            payload: { refId },
          },
        ]);
        await tx.audit.record({
          actorId,
          role: "SECURITY_ADMIN",
          action: "UOW_ROLLBACK",
          entityType: "UOW",
          entityId: refId,
          beforeJson: {},
          afterJson: { refId },
        });
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow("intentional rollback");

    expect(
      await client.journalEntry.findUnique({
        where: { refType_refId: { refType: "PAYMENT_ATTEMPT", refId } },
      }),
    ).toBeNull();
    expect(await client.outboxEvent.count({ where: { aggregateId } })).toBe(0);
    expect(await client.auditOutbox.count({ where: { entityId: refId } })).toBe(0);
  });

  test("commit LSN increases between write transactions", async () => {
    const firstRef = uniqueId("uow-lsn-a");
    const secondRef = uniqueId("uow-lsn-b");
    const first = await uow.run(async (tx) => {
      await tx.outbox.enqueue({
        topic: "config.invalidated",
        aggregateType: "uow_test",
        aggregateId: firstRef,
        payload: {},
      });
      return firstRef;
    });
    const second = await uow.run(async (tx) => {
      await tx.outbox.enqueue({
        topic: "config.invalidated",
        aggregateType: "uow_test",
        aggregateId: secondRef,
        payload: {},
      });
      return secondRef;
    });

    const { compareLsn } = await import("../../lib/storageEngine/lsn");
    expect(compareLsn(second.commitLsn, first.commitLsn)).toBe(1);
    expect(second.durationMs).toBeGreaterThanOrEqual(0);

    await cleanupRefs(firstRef);
    await cleanupRefs(secondRef);
  });

  test("a short unit of work kills pg_sleep through the transaction timeout", async () => {
    const started = performance.now();
    await expect(
      uow.run(
        async (tx) => tx.db.$queryRaw(Prisma.sql`SELECT pg_sleep(2)`),
        { timeoutMs: 500 },
      ),
    ).rejects.toThrow();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2_500);
  });

  test("PostgreSQL statement_timeout cancels a slow query before the transaction timeout", async () => {
    const started = performance.now();
    const error = await uow
      .run(
        async (tx) => tx.db.$queryRaw(Prisma.sql`SELECT pg_sleep(2)`),
        { timeoutMs: 1_200 },
      )
      .catch((caught: unknown) => caught);
    const elapsed = performance.now() - started;
    expect(error).toBeInstanceOf(Error);
    const text = [
      (error as Error).message,
      JSON.stringify((error as { meta?: unknown }).meta ?? {}),
    ].join(" ");
    // The adapter floors statement_timeout at 1000ms; 57014 is PostgreSQL's
    // "canceling statement due to statement timeout".
    expect(text).toMatch(/57014|statement timeout|canceling statement/i);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("sorts two shared shard locks so 20 opposite-order transactions never deadlock", async () => {
    const refPrefix = uniqueId("uow-lock");
    const accountA = await seedGlAccount(client);
    const accountB = await seedGlAccount(client);
    const accountIds = [accountA.id, accountB.id];

    try {
      await Promise.all(
        Array.from({ length: 20 }, async (_, index) => {
          const targets =
            index % 2 === 0
              ? [
                  { glAccountId: accountA.id, shardId: 0 },
                  { glAccountId: accountB.id, shardId: 0 },
                ]
              : [
                  { glAccountId: accountB.id, shardId: 0 },
                  { glAccountId: accountA.id, shardId: 0 },
                ];
          await uow.run(
            async (tx) => {
              const locked = await tx.lockGlAccountShardsSorted(targets);
              expect(locked.size).toBe(2);
              await tx.db.$executeRawUnsafe(
                `UPDATE gl_account_shards SET current_balance = current_balance + 1
                 WHERE gl_account_id = $1::uuid AND shard_id = 0`,
                accountA.id,
              );
              await tx.db.$executeRawUnsafe(
                `UPDATE gl_account_shards SET current_balance = current_balance + 1
                 WHERE gl_account_id = $1::uuid AND shard_id = 0`,
                accountB.id,
              );
            },
            { timeoutMs: 10_000 },
          );
        }),
      );

      const shards = await client.glAccountShard.findMany({
        where: { glAccountId: { in: accountIds }, shardId: 0 },
        orderBy: { glAccountId: "asc" },
      });
      expect(shards).toHaveLength(2);
      for (const shard of shards) {
        expect(shard.currentBalance.toString()).toBe("20");
      }
    } finally {
      await cleanupLedger(client, accountIds, refPrefix);
    }
  });

  test("50 parallel FOR UPDATE increments preserve the exact final sum", async () => {
    const refPrefix = uniqueId("uow-parallel");
    const accountA = await seedGlAccount(client);
    const accountB = await seedGlAccount(client);
    const accountIds = [accountA.id, accountB.id];

    try {
      await Promise.all(
        Array.from({ length: 50 }, async (_, index) => {
          const targets =
            index % 2 === 0
              ? [
                  { glAccountId: accountA.id, shardId: 0 },
                  { glAccountId: accountB.id, shardId: 0 },
                ]
              : [
                  { glAccountId: accountB.id, shardId: 0 },
                  { glAccountId: accountA.id, shardId: 0 },
                ];
          await uow.run(
            async (tx) => {
              const locked = await tx.lockGlAccountShardsSorted(targets);
              expect(locked.get(`${accountA.id}:0`)?.currentBalance.toString()).toBeDefined();
              expect(locked.get(`${accountB.id}:0`)?.currentBalance.toString()).toBeDefined();
              await tx.db.$executeRawUnsafe(
                `UPDATE gl_account_shards SET current_balance = current_balance + 1
                 WHERE gl_account_id = $1::uuid AND shard_id = 0`,
                accountA.id,
              );
              await tx.db.$executeRawUnsafe(
                `UPDATE gl_account_shards SET current_balance = current_balance + 1
                 WHERE gl_account_id = $1::uuid AND shard_id = 0`,
                accountB.id,
              );
            },
            { timeoutMs: 10_000 },
          );
        }),
      );

      const shards = await client.glAccountShard.findMany({
        where: { glAccountId: { in: accountIds }, shardId: 0 },
      });
      const sum = shards.reduce(
        (total, shard) => total + Number(shard.currentBalance.toString()),
        0,
      );
      expect(shards).toHaveLength(2);
      expect(shards.map((shard) => shard.currentBalance.toString())).toEqual(["50", "50"]);
      expect(sum).toBe(100);
    } finally {
      await cleanupLedger(client, accountIds, refPrefix);
    }
  });

  test("honours the isolation-level override and treats operationName as a no-op", async () => {
    const isolation = await uow.run(
      async (tx) => {
        const rows = await tx.db.$queryRaw<Array<{ transaction_isolation: string }>>(
          Prisma.sql`SHOW transaction_isolation`,
        );
        return rows[0]?.transaction_isolation;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        operationName: "uow-isolation-test",
        timeoutMs: 5_000,
      },
    );
    expect(isolation.data).toBe("serializable");

    const noop = await uow.run(async () => "ok", {
      operationName: "uow-operation-name-noop",
    });
    expect(noop.data).toBe("ok");
    expect(noop.commitLsn).toBeTruthy();
  });

  test("parameterizes malicious lock targets and outbox payloads", async () => {
    const refPrefix = uniqueId("uow-injection");
    const before = await client.glAccountShard.count();
    await expect(
      uow.run(async (tx) => {
        await tx.lockGlAccountShardsSorted([
          { glAccountId: "00000000-0000-0000-0000-000000000000' OR '1'='1", shardId: 0 },
        ]);
      }),
    ).rejects.toThrow();
    expect(await client.glAccountShard.count()).toBe(before);

    const aggregateId = uniqueId("uow-injection-outbox");
    const payload = {
      text: "'); DROP TABLE outbox_events; --",
      nested: ["' OR 1=1 --", { quote: "\"quoted\"" }],
    };
    await uow.run(async (tx) => {
      await tx.outbox.enqueue({
        topic: "config.invalidated",
        aggregateType: "uow_test",
        aggregateId,
        payload,
      });
    });
    const stored = await client.outboxEvent.findFirst({ where: { aggregateId } });
    expect(stored?.payloadJson).toEqual(payload);
    expect(await client.outboxEvent.count({ where: { aggregateId } })).toBe(1);

    await cleanupRefs(refPrefix);
    await cleanupRefs(aggregateId);
  });

  test("returns an empty lock map for an empty target list", async () => {
    const locked = await uow.run(async (tx) => tx.lockGlAccountShardsSorted([]));
    expect(locked.data.size).toBe(0);
  });
});
