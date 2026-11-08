import { afterAll, expect, test } from "bun:test";
import { createLedgerPoster } from "../../lib/storageEngine/ledgerPosterFactory";
import { loadShardBalanceRows, naturalShardBalance } from "../../lib/storageEngine/shardBalances";
import { writeAudit } from "../../lib/audit/writeAudit";
import { enqueueOutboxEvent } from "../../lib/storageEngine/outbox";
import { withLedgerMaintenance } from "../helpers/ledgerMaintenance";
import {
  DATABASE_URL,
  cleanupLedger,
  createPrisma,
  databaseIsReachable,
  describeDatabase,
  seedActorUser,
  seedGlAccount,
  uniqueId,
} from "./helpers/db";

const client = createPrisma({ max: 10 });
const originalAuditUrl = process.env.AUDIT_DATABASE_URL;

afterAll(async () => {
  if (originalAuditUrl === undefined) {
    delete process.env.AUDIT_DATABASE_URL;
  } else {
    process.env.AUDIT_DATABASE_URL = originalAuditUrl;
  }
  await client.$disconnect().catch(() => undefined);
});

if (!databaseIsReachable) {
  test.skip("write-path wiring suite requires the live PostgreSQL database", () => undefined);
}

describeDatabase("transactional write-path helpers (live PostgreSQL)", () => {
  test("writeAudit writes the compatibility row and the transactional audit outbox atomically", async () => {
    process.env.AUDIT_DATABASE_URL = DATABASE_URL;
    const actorId = await seedActorUser(client);
    const entityId = uniqueId("write-audit");
    const created = await writeAudit(client, {
      data: {
        actorId,
        role: "SECURITY_ADMIN",
        action: "WRITE_AUDIT_INTEGRATION",
        entityType: "UOW",
        entityId,
        beforeJson: { step: 1 },
        afterJson: { step: 2 },
      },
    });
    try {
      const audit = await client.auditLog.findUnique({ where: { id: created.id } });
      const outbox = await client.auditOutbox.findUnique({ where: { id: created.id } });
      expect(audit).not.toBeNull();
      expect(outbox).not.toBeNull();
      expect(outbox?.entityId).toBe(entityId);
      expect(outbox?.action).toBe("WRITE_AUDIT_INTEGRATION");
      expect(outbox?.createdAt).toEqual(audit?.createdAt);
    } finally {
      await client.auditOutbox.deleteMany({ where: { id: created.id } });
      await withLedgerMaintenance(client, (tx) => tx.auditLog.deleteMany({ where: { id: created.id } }));
    }
  });

  test("enqueueOutboxEvent writes the event in the current transaction", async () => {
    const aggregateId = uniqueId("outbox-integration");
    try {
      await client.$transaction(async (tx) => {
        await enqueueOutboxEvent(tx, {
          topic: "config.invalidated",
          aggregateType: "INTEGRATION",
          aggregateId,
          payload: { aggregateId },
        });
      });
      const rows = await client.outboxEvent.findMany({
        where: { aggregateId },
        orderBy: { id: "asc" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payloadJson).toMatchObject({ aggregateId });
    } finally {
      await client.outboxEvent.deleteMany({ where: { aggregateId } });
    }
  });

  test("posted journal lines update the shard balances and the shard reader returns natural signs", async () => {
    const refId = uniqueId("shard-read");
    const treasury = await seedGlAccount(client, { accountType: "TREASURY", shardCount: 16 });
    const wallet = await seedGlAccount(client, { accountType: "MERCHANT_WALLET", shardCount: 1 });
    const poster = createLedgerPoster(client, { emitOutbox: true });
    try {
      const posted = await poster.post({
        refType: "PAYMENT_ATTEMPT",
        refId,
        description: "shard read integration",
        lines: [
          {
            direction: "DEBIT",
            amount: "100.0000",
            account: { accountType: "TREASURY", accountId: treasury.id },
          },
          {
            direction: "CREDIT",
            amount: "100.0000",
            account: { accountType: "MERCHANT_WALLET", accountId: wallet.id },
          },
        ],
      });
      expect(posted.created).toBe(true);

      const rows = await loadShardBalanceRows(client as never, [treasury.id, wallet.id]);
      const treasuryRow = rows.find((row) => row.id === treasury.id);
      const walletRow = rows.find((row) => row.id === wallet.id);
      expect(treasuryRow).toBeDefined();
      expect(walletRow).toBeDefined();
      expect(Number(naturalShardBalance("TREASURY", treasuryRow!.total))).toBe(100);
      expect(Number(naturalShardBalance("MERCHANT_WALLET", walletRow!.total))).toBe(100);

      const ledgerEvent = await client.outboxEvent.findFirst({
        where: {
          topic: "ledger.entry_posted",
          aggregateId: posted.entry.id,
        },
      });
      expect(ledgerEvent).not.toBeNull();
    } finally {
      await client.$executeRawUnsafe(
        "DELETE FROM outbox_events WHERE payload_json->>'refId' = $1",
        refId,
      );
      await cleanupLedger(client, [treasury.id, wallet.id], refId);
    }
  });
});
