import { afterAll, expect, test } from "bun:test";
import { writeAudit } from "../../../lib/audit/writeAudit";
import { createLedgerPoster } from "../../../lib/storageEngine/ledgerPosterFactory";
import { loadShardBalanceRows } from "../../../lib/storageEngine/shardBalances";
import { withLedgerMaintenance } from "../../helpers/ledgerMaintenance";
import {
  DATABASE_URL,
  cleanupLedger,
  createPrisma,
  databaseIsReachable,
  describeDatabase,
  seedGlAccount,
  uniqueId,
  uniqueUuid,
} from "../helpers/db";

const client = createPrisma({ max: 10 });
const originalAuditUrl = process.env.AUDIT_DATABASE_URL;
const report = (name: string, value: number): void => {
  console.log(`[benchmark] ${name}: ${value.toFixed(2)}ms`);
};

afterAll(async () => {
  if (originalAuditUrl === undefined) {
    delete process.env.AUDIT_DATABASE_URL;
  } else {
    process.env.AUDIT_DATABASE_URL = originalAuditUrl;
  }
  await client.$disconnect().catch(() => undefined);
});

if (!databaseIsReachable) {
  test.skip("write-path benchmarks require the live PostgreSQL database", () => undefined);
}

describeDatabase("write-path benchmark (live PostgreSQL)", () => {
  test("300 transactional audit writes with audit_outbox finish under 10s", async () => {
    process.env.AUDIT_DATABASE_URL = DATABASE_URL;
    const actorId = uniqueUuid();
    const prefix = uniqueId("bench-audit");
    const ids: string[] = [];
    const started = performance.now();
    try {
      for (let index = 0; index < 300; index += 1) {
        const created = await writeAudit(client, {
          data: {
            actorId,
            role: "SECURITY_ADMIN",
            action: "BENCH_AUDIT_WRITE",
            entityType: "BENCH",
            entityId: `${prefix}-${index}`,
            beforeJson: { index },
            afterJson: { index, ok: true },
          },
        });
        ids.push(created.id);
      }
      const elapsed = performance.now() - started;
      report("300 writeAudit (audit_log + audit_outbox)", elapsed);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      await client.auditOutbox.deleteMany({ where: { id: { in: ids } } });
      await withLedgerMaintenance(client, (tx) => tx.auditLog.deleteMany({ where: { id: { in: ids } } }));
    }
  });

  test("shard balance reads stay below 25ms p95 for a 16-shard account", async () => {
    const refId = uniqueId("bench-shard");
    const treasury = await seedGlAccount(client, { accountType: "TREASURY", shardCount: 16 });
    const wallet = await seedGlAccount(client, { accountType: "MERCHANT_WALLET", shardCount: 1 });
    const poster = createLedgerPoster(client, { emitOutbox: false, shardCount: 16 });
    try {
      for (let index = 0; index < 120; index += 1) {
        await poster.post({
          refType: "PAYMENT_ATTEMPT",
          refId: `${refId}-${index}`,
          description: "shard read benchmark",
          lines: [
            {
              direction: "DEBIT",
              amount: "1.0000",
              account: { accountType: "TREASURY", accountId: treasury.id },
            },
            {
              direction: "CREDIT",
              amount: "1.0000",
              account: { accountType: "MERCHANT_WALLET", accountId: wallet.id },
            },
          ],
        });
      }
      const samples: number[] = [];
      for (let index = 0; index < 50; index += 1) {
        const started = performance.now();
        await loadShardBalanceRows(client as never, [treasury.id, wallet.id]);
        samples.push(performance.now() - started);
      }
      samples.sort((left, right) => left - right);
      const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
      report("shard balance read p95 (two accounts)", p95);
      expect(p95).toBeLessThan(25);
    } finally {
      await client.$executeRawUnsafe(
        "DELETE FROM outbox_events WHERE payload_json->>'refId' LIKE $1",
        `${refId}-%`,
      );
      await cleanupLedger(client, [treasury.id, wallet.id], refId);
    }
  });
});
