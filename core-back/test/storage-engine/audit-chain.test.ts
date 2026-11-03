import { afterAll, describe, expect, test } from "bun:test";
import type { AuditEnvelope } from "../../lib/storageEngine/ports";
import {
  computeAuditRowHash,
  DedicatedAuditDatabaseDriver,
  stableJson,
} from "../../lib/storageEngine/auditAndLogAdapters";
import { AuditShipperWorker } from "../../lib/storageEngine/outboxWorkers";
import {
  createAuditSandbox,
  createWorkerSandbox,
  databaseIsReachable,
  describeDatabase,
  uniqueId,
  uniqueUuid,
} from "./helpers/db";

afterAll(async () => {
  // Every sandbox owns its pool; nothing global remains open.
});

if (!databaseIsReachable) {
  test.skip("audit chain suite requires the live database", () => undefined);
}

const makeEntry = (overrides: Partial<AuditEnvelope> = {}): AuditEnvelope => ({
  actorId: uniqueUuid(),
  actorEmail: "auditor@example.test",
  role: "SECURITY_ADMIN",
  action: "TEST_ACTION",
  entityType: "TEST_ENTITY",
  entityId: uniqueId("entity"),
  beforeJson: { before: true, nested: { b: 2, a: 1 } },
  afterJson: { after: true, list: [1, 2, 3] },
  ...overrides,
});

describe("audit row hashing", () => {
  test("is independent of JSON key insertion order", () => {
    const base = {
      id: uniqueUuid(),
      createdAt: new Date("2026-01-02T03:04:05.678Z"),
      actorId: uniqueUuid(),
      action: "A",
      entityType: "E",
      entityId: "id",
    };
    const one = computeAuditRowHash("0".repeat(64), {
      ...base,
      beforeJson: { z: 1, a: { y: 2, b: 3 } },
      afterJson: { list: [{ b: 1, a: 2 }] },
    });
    const two = computeAuditRowHash("0".repeat(64), {
      ...base,
      beforeJson: { a: { b: 3, y: 2 }, z: 1 },
      afterJson: { list: [{ a: 2, b: 1 }] },
    });
    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(stableJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });
});

describeDatabase("dedicated audit database (live PostgreSQL)", () => {
  test("appends 100 rows into a valid hash chain", async () => {
    const sandbox = await createAuditSandbox("audit-chain");
    try {
      const entries = Array.from({ length: 100 }, (_, index) =>
        makeEntry({
          action: `ACTION_${index}`,
          entityId: `entity-${index}`,
          beforeJson: { index },
          afterJson: { index, even: index % 2 === 0 },
        }),
      );
      const inserted = await sandbox.driver.appendBatch(entries);
      expect(inserted).toHaveLength(100);
      expect(inserted.every((row) => row.prevHash.length === 64)).toBe(true);
      expect(inserted[0]?.prevHash).toBe("0".repeat(64));
      for (let index = 1; index < inserted.length; index += 1) {
        expect(inserted[index]?.prevHash).toBe(inserted[index - 1]?.rowHash);
      }
      const verification = await sandbox.driver.verifyHashChainIntegrity();
      expect(verification).toEqual({ verifiedCount: 100, valid: true });
      expect(await sandbox.driver.countAuditLogs({ limit: 10 })).toBe(100);
    } finally {
      await sandbox.cleanup();
    }
  });

  test("the immutability trigger rejects UPDATE and DELETE, and tampering is located", async () => {
    const sandbox = await createAuditSandbox("audit-tamper");
    try {
      const inserted = await sandbox.driver.appendBatch(
        Array.from({ length: 5 }, (_, index) =>
          makeEntry({ action: `TAMPER_${index}`, entityId: `tamper-${index}` }),
        ),
      );
      const target = inserted[2] as (typeof inserted)[number];

      await expect(
        sandbox.pool.query("UPDATE " + sandbox.table + " SET action = 'x' WHERE id = $1", [
          target.id,
        ]),
      ).rejects.toThrow(/AUDIT_TAMPER_PROHIBITED/);
      await expect(
        sandbox.pool.query("DELETE FROM " + sandbox.table + " WHERE id = $1", [target.id]),
      ).rejects.toThrow(/AUDIT_TAMPER_PROHIBITED/);

      await sandbox.pool.query(
        `ALTER TABLE ${sandbox.table} DISABLE TRIGGER trg_audit_immutable`,
      );
      await sandbox.pool.query(
        `UPDATE ${sandbox.table} SET after_json = '{"tampered":true}'::jsonb WHERE id = $1`,
        [target.id],
      );
      await sandbox.pool.query(
        `ALTER TABLE ${sandbox.table} ENABLE TRIGGER trg_audit_immutable`,
      );

      const verification = await sandbox.driver.verifyHashChainIntegrity();
      expect(verification.valid).toBe(false);
      expect(verification.firstBrokenId).toBe(target.id);
      expect(verification.verifiedCount).toBe(2);
    } finally {
      await sandbox.cleanup();
    }
  });

  test("concurrent and duplicate append calls serialize through the advisory lock", async () => {
    const sandbox = await createAuditSandbox("audit-concurrent");
    try {
      const shared = makeEntry({ action: "CONCURRENT_DUPLICATE", entityId: "same-entity" });
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          sandbox.driver.appendBatch([
            index % 2 === 0
              ? shared
              : makeEntry({ action: "CONCURRENT", entityId: `concurrent-${index}` }),
          ]),
        ),
      );
      expect(results.every((rows) => rows.length === 1)).toBe(true);
      const verification = await sandbox.driver.verifyHashChainIntegrity();
      expect(verification).toEqual({ verifiedCount: 8, valid: true });
      expect(await sandbox.driver.countAuditLogs({ limit: 1 })).toBe(8);

      const rows = await sandbox.pool.query<{ seq_no: string }>(
        `SELECT seq_no FROM ${sandbox.table} ORDER BY seq_no ASC`,
      );
      expect(rows.rows.map((row) => Number(row.seq_no))).toEqual(
        Array.from({ length: 8 }, (_, index) => index + 1),
      );
    } finally {
      await sandbox.cleanup();
    }
  });

  test("audit search filters stay parameterized", async () => {
    const sandbox = await createAuditSandbox("audit-search");
    try {
      await sandbox.driver.appendBatch([
        makeEntry({ action: "SEARCHABLE", entityId: "entity-1" }),
        makeEntry({ action: "OTHER", entityId: "entity-2" }),
      ]);
      const injected = await sandbox.driver.queryAuditLogs({
        searchPrefix: "%' OR 1=1 --",
        limit: 10,
      });
      expect(injected.items).toHaveLength(0);
      const matching = await sandbox.driver.queryAuditLogs({
        searchPrefix: "SEARCH",
        limit: 10,
      });
      expect(matching.items).toHaveLength(1);
      expect(matching.items[0]?.action).toBe("SEARCHABLE");
      const fetched = await sandbox.driver.getAuditLogById(
        (matching.items[0] as { id: string }).id,
      );
      expect(fetched?.entityId).toBe("entity-1");
    } finally {
      await sandbox.cleanup();
    }
  });

  test("four audit shippers drain audit_outbox exactly once with SKIP LOCKED", async () => {
    const auditSandbox = await createAuditSandbox("audit-shipper");
    const workerSandbox = await createWorkerSandbox("audit-shipper-outbox");
    const entityPrefix = uniqueId("audit-shipper");
    try {
      const ids = Array.from({ length: 40 }, () => uniqueUuid());
      for (const [index, id] of ids.entries()) {
        await workerSandbox.client.$executeRawUnsafe(
          `INSERT INTO audit_outbox
             (id, actor_id, role, action, entity_type, entity_id, before_json, after_json, created_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb, now())`,
          id,
          uniqueUuid(),
          "SECURITY_ADMIN",
          `SHIP_${index}`,
          "AUDIT_SHIPPER",
          `${entityPrefix}-${index}`,
          JSON.stringify({ index }),
          JSON.stringify({ index, shipped: true }),
        );
      }

      const workers = Array.from({ length: 4 }, () =>
        new AuditShipperWorker(
          workerSandbox.newClient({ max: 4 }),
          auditSandbox.driver,
          { batchSize: 10 },
        ),
      );
      const drained = await Promise.all(workers.map((worker) => worker.drain()));
      expect(drained.reduce((sum, count) => sum + count, 0)).toBe(40);
      expect(await auditSandbox.driver.countAuditLogs({ limit: 1 })).toBe(40);
      expect((await auditSandbox.driver.verifyHashChainIntegrity()).valid).toBe(true);
      const pending = await workerSandbox.client.$queryRawUnsafe<Array<{ count: string }>>(
        "SELECT count(*)::text AS count FROM audit_outbox WHERE shipped_at IS NULL",
      );
      expect(Number(pending[0]?.count ?? "0")).toBe(0);

      const rerun = await Promise.all(workers.map((worker) => worker.drain()));
      expect(rerun.reduce((sum, count) => sum + count, 0)).toBe(0);
      expect(await auditSandbox.driver.countAuditLogs({ limit: 1 })).toBe(40);
    } finally {
      await auditSandbox.cleanup();
      await workerSandbox.cleanup();
    }
  });
});

// Keep the concrete driver import exercised even if a future refactor makes
// the sandbox helper return an interface.
void DedicatedAuditDatabaseDriver;
