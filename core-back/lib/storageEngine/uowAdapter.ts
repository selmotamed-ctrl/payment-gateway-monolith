import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import type {
  AuditEnvelope,
  OutboxEnvelope,
  StorageTx,
  UnitOfWorkOptions,
  UnitOfWorkPort,
  UnitOfWorkResult,
} from "./ports";
import { uuidv7 } from "./uuid";

export class PostgresUnitOfWorkAdapter implements UnitOfWorkPort {
  constructor(
    private readonly primaryDb: PrismaClient,
    private readonly onAfterCommitTrigger?: () => void,
  ) {}

  public async run<T>(
    fn: (tx: StorageTx) => Promise<T>,
    options?: UnitOfWorkOptions,
  ): Promise<UnitOfWorkResult<T>> {
    const startMs = performance.now();
    const timeoutMs = options?.timeoutMs ?? 5_000;

    const result = await this.primaryDb.$transaction(
      async (prismaTx) => {
        const statementTimeout = Math.max(1_000, timeoutMs - 250);
        await prismaTx.$executeRawUnsafe(
          `SET LOCAL statement_timeout = '${statementTimeout}ms'`,
        );

        const pendingOutbox: OutboxEnvelope[] = [];
        const pendingAudit: Array<AuditEnvelope & { id: string }> = [];

        const storageTx: StorageTx = {
          db: prismaTx,
          outbox: {
            enqueue: async (event) => {
              pendingOutbox.push(event);
            },
            enqueueMany: async (events) => {
              pendingOutbox.push(...events);
            },
          },
          audit: {
            record: async (entry) => {
              const id = uuidv7();
              pendingAudit.push({ ...entry, id });
              return id;
            },
          },
          lockGlAccountShardsSorted: async (targets) => {
            if (targets.length === 0) {
              return new Map();
            }
            const uniqueSorted = Array.from(
              new Map(
                targets.map((target) => [
                  `${target.glAccountId}:${target.shardId}`,
                  target,
                ]),
              ).values(),
            ).sort((left, right) =>
              left.glAccountId !== right.glAccountId
                ? left.glAccountId.localeCompare(right.glAccountId)
                : left.shardId - right.shardId,
            );

            const tuples = uniqueSorted.map(
              (target) =>
                Prisma.sql`(${target.glAccountId}::uuid, ${target.shardId}::smallint)`,
            );

            const rows = await prismaTx.$queryRaw<
              Array<{
                gl_account_id: string;
                shard_id: number;
                current_balance: Prisma.Decimal;
              }>
            >(
              Prisma.sql`
                SELECT gl_account_id, shard_id, current_balance
                FROM gl_account_shards
                WHERE (gl_account_id, shard_id) IN (${Prisma.join(tuples, ", ")})
                ORDER BY gl_account_id ASC, shard_id ASC
                FOR UPDATE
              `,
            );

            const map = new Map<string, { currentBalance: Prisma.Decimal }>();
            for (const row of rows) {
              map.set(`${row.gl_account_id}:${row.shard_id}`, {
                currentBalance: new Prisma.Decimal(row.current_balance),
              });
            }
            return map;
          },
        };

        const data = await fn(storageTx);

        if (pendingOutbox.length > 0) {
          const now = new Date();
          await prismaTx.outboxEvent.createMany({
            data: pendingOutbox.map((event) => ({
              topic: event.topic,
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              merchantId: event.merchantId ?? null,
              payloadJson: event.payload as Prisma.InputJsonValue,
              createdAt: now,
            })),
          });
        }

        if (pendingAudit.length > 0) {
          const now = new Date();
          await prismaTx.auditOutbox.createMany({
            data: pendingAudit.map((entry) => ({
              id: entry.id,
              actorId: entry.actorId,
              actorEmail: entry.actorEmail ?? null,
              role: entry.role,
              action: entry.action,
              entityType: entry.entityType,
              entityId: entry.entityId,
              merchantId: entry.merchantId ?? null,
              approvalRequestId: entry.approvalRequestId ?? null,
              requestId: entry.requestId ?? null,
              clientIp: entry.clientIp ?? null,
              userAgent: entry.userAgent ?? null,
              beforeJson: entry.beforeJson as Prisma.InputJsonValue,
              afterJson: entry.afterJson as Prisma.InputJsonValue,
              createdAt: now,
            })),
          });
        }

        const lsnRows = await prismaTx.$queryRaw<Array<{ lsn: string }>>(
          Prisma.sql`SELECT pg_current_wal_lsn()::text AS lsn`,
        );
        const commitLsn = lsnRows[0]?.lsn ?? "0/0";

        return { data, commitLsn };
      },
      {
        maxWait: 2_500,
        timeout: timeoutMs,
        isolationLevel:
          options?.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );

    try {
      this.onAfterCommitTrigger?.();
    } catch {
      // The write is already committed; a shipper wake-up failure must not
      // turn a successful payment into an error.
    }

    return {
      data: result.data,
      commitLsn: result.commitLsn,
      durationMs: Math.round(performance.now() - startMs),
    };
  }
}
