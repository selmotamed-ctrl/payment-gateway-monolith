import { describe, expect, test } from "bun:test";
import {
  KYB_SUSPENSION_CURSOR,
  KybExpiryWorker,
} from "../../engine/workers/KybExpiryWorker";
import {
  InMemoryWorkerCursorStore,
  SqlWorkerCursorStore,
} from "../../engine/workers/workerCursorStore";
import type { WorkerLogger } from "../../engine/workers/workerRuntime";
import { DEFAULT_REQUIRED_KYB_DOCUMENTS } from "../../lib/joinRequestOnboarding";

/**
 * AUTO-25: the KYB grace-suspension pass used to read only the first
 * `batchSize` ACTIVE merchants on every tick. With a keyset cursor persisted
 * between ticks every merchant is evaluated over successive ticks.
 */

const NOW = new Date("2026-11-09T06:00:00.000Z");
const LONG_AGO = new Date("2025-01-01T00:00:00.000Z");

interface FakeMerchant {
  id: string;
  status: string;
  legalName: string;
  tradeName: string | null;
  businessCategory: string | null;
  riskTier: string | null;
  kybStatus: string;
  nextKybReviewAt: Date | null;
}

interface FakeDocument {
  id: string;
  merchantId: string;
  docType: string;
  status: string;
  expiresOn: Date | null;
}

const merchantId = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const matchesStatus = (value: string, where: unknown): boolean => {
  if (where === undefined) return true;
  if (typeof where === "string") return value === where;
  const condition = where as { in?: string[]; not?: string };
  if (condition.in) return condition.in.includes(value);
  if (condition.not) return value !== condition.not;
  return true;
};

const createKybFake = (options: { merchants: number; healthy?: number[]; failingMerchant?: string }) => {
  const merchants: FakeMerchant[] = Array.from({ length: options.merchants }, (_, index) => ({
    id: merchantId(index + 1),
    status: "ACTIVE",
    legalName: `Merchant ${index + 1}`,
    tradeName: null,
    businessCategory: null,
    riskTier: "STANDARD",
    kybStatus: "APPROVED",
    nextKybReviewAt: null,
  }));
  const documents: FakeDocument[] = merchants.map((merchant, index) => ({
    id: `doc-${index + 1}`,
    merchantId: merchant.id,
    docType: DEFAULT_REQUIRED_KYB_DOCUMENTS[0],
    // Healthy merchants hold a current document; the others one that expired
    // long before the 30-day grace period.
    status: options.healthy?.includes(index + 1) ? "ACCEPTED" : "EXPIRED",
    expiresOn: options.healthy?.includes(index + 1) ? new Date("2030-01-01T00:00:00.000Z") : LONG_AGO,
  }));
  const pages: Array<{ after: string | null; ids: string[] }> = [];
  const audits: Array<{ action: string; entityId: string }> = [];

  const db: Record<string, unknown> = {
    platformSetting: { findFirst: async () => null },
    merchant: {
      findMany: async (args: {
        where: { status?: string; id?: { gt: string }; nextKybReviewAt?: unknown };
        take?: number;
      }) => {
        if (args.where.nextKybReviewAt) return [];
        const after = args.where.id?.gt ?? null;
        const page = merchants
          .filter((merchant) => matchesStatus(merchant.status, args.where.status))
          .filter((merchant) => after === null || merchant.id > after)
          .sort((left, right) => (left.id < right.id ? -1 : 1))
          .slice(0, args.take ?? merchants.length)
          .map((merchant) => ({ ...merchant }));
        pages.push({ after, ids: page.map((merchant) => merchant.id) });
        return page;
      },
      updateMany: async (args: { where: { id: string; status?: string }; data: Partial<FakeMerchant> }) => {
        const merchant = merchants.find(
          (candidate) => candidate.id === args.where.id && matchesStatus(candidate.status, args.where.status),
        );
        if (!merchant) return { count: 0 };
        const { status, kybStatus } = args.data;
        if (status) merchant.status = status;
        if (kybStatus) merchant.kybStatus = kybStatus;
        return { count: 1 };
      },
      findUnique: async (args: { where: { id: string } }) => {
        const merchant = merchants.find((candidate) => candidate.id === args.where.id);
        return merchant ? { id: merchant.id, contactEmail: "ops@example.test", contactPhone: null } : null;
      },
    },
    kybDocument: {
      findMany: async (args: { where: { merchantId?: string; status?: unknown } }) => {
        if (options.failingMerchant && args.where.merchantId === options.failingMerchant) throw new Error("document store timeout");
        return documents
          .filter((document) => args.where.merchantId === undefined || document.merchantId === args.where.merchantId)
          .filter((document) => matchesStatus(document.status, args.where.status))
          .filter(() => args.where.merchantId !== undefined) // the other passes find nothing due
          .map((document) => ({ ...document }));
      },
      updateMany: async () => ({ count: 0 }),
    },
    kybRevalidationRequest: { findMany: async () => [] },
    user: {
      findFirst: async () => ({ id: "system", email: "system@example.test", phone: null }),
      create: async () => ({ id: "system" }),
    },
    auditLog: {
      create: async (args: { data: { action: string; entityId: string } }) => {
        audits.push({ action: args.data.action, entityId: args.data.entityId });
        return { id: `audit-${audits.length}` };
      },
    },
    notificationTemplate: { createMany: async () => ({ count: 0 }) },
    notification: { create: async () => ({}) },
  };
  db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...db, $transaction: undefined });

  return { db, merchants, pages, audits };
};

const quietLogger = (): WorkerLogger & { errors: string[] } => {
  const errors: string[] = [];
  return {
    errors,
    info: () => undefined,
    warn: () => undefined,
    error: (message, meta) => {
      errors.push(`${message} ${JSON.stringify(meta ?? {})}`);
    },
  };
};

const buildWorker = (
  fake: ReturnType<typeof createKybFake>,
  cursorStore = new InMemoryWorkerCursorStore(),
  batchSize = 2,
) => {
  const logger = quietLogger();
  const worker = new KybExpiryWorker({
    db: fake.db as never,
    repositories: {} as never,
    clock: () => NOW,
    batchSize,
    logger,
    cursorStore,
  });
  return { worker, logger, cursorStore };
};

describe("AUTO-25 KybExpiryWorker keyset cursor", () => {
  test("every ACTIVE merchant is evaluated over successive ticks when there are more merchants than the batch size", async () => {
    const fake = createKybFake({ merchants: 5 });
    const { worker, cursorStore } = buildWorker(fake);

    await worker.runOnce();
    expect(fake.merchants.filter((merchant) => merchant.status === "SUSPENDED").map((merchant) => merchant.id)).toEqual([
      merchantId(1),
      merchantId(2),
    ]);
    expect(await cursorStore.read(KYB_SUSPENSION_CURSOR)).toBe(merchantId(2));

    await worker.runOnce();
    await worker.runOnce();
    // Before AUTO-25 merchants 3..5 were never evaluated.
    expect(fake.merchants.every((merchant) => merchant.status === "SUSPENDED")).toBe(true);
    expect(fake.audits.filter((audit) => audit.action === "MERCHANT_SUSPENDED_KYB_EXPIRED")).toHaveLength(5);
    expect(fake.pages.map((page) => page.after)).toEqual([null, merchantId(2), merchantId(4)]);
    // The short third page reached the end: the cursor wrapped.
    expect(await cursorStore.read(KYB_SUSPENSION_CURSOR)).toBeNull();
  });

  test("the cursor wraps to the start and keeps cycling through healthy merchants", async () => {
    const fake = createKybFake({ merchants: 4, healthy: [1, 2, 3, 4] });
    const { worker, cursorStore } = buildWorker(fake);
    for (let tick = 0; tick < 4; tick += 1) await worker.runOnce();
    expect(fake.pages.map((page) => page.ids)).toEqual([
      [merchantId(1), merchantId(2)],
      [merchantId(3), merchantId(4)],
      [], // end reached exactly on a full page: an empty page wraps the cursor
      [merchantId(1), merchantId(2)],
    ]);
    expect(fake.merchants.every((merchant) => merchant.status === "ACTIVE")).toBe(true);
    expect(await cursorStore.read(KYB_SUSPENSION_CURSOR)).toBe(merchantId(2));
  });

  test("the cursor is persisted, so a new worker instance (restart or new leader) resumes where the last tick stopped", async () => {
    const fake = createKybFake({ merchants: 5 });
    const store = new InMemoryWorkerCursorStore();
    await buildWorker(fake, store).worker.runOnce();
    await buildWorker(fake, store).worker.runOnce();
    expect(fake.pages.map((page) => page.after)).toEqual([null, merchantId(2)]);
    expect(fake.merchants.slice(0, 4).every((merchant) => merchant.status === "SUSPENDED")).toBe(true);
    expect(fake.merchants[4]!.status).toBe("ACTIVE");
  });

  test("one failing merchant is logged and does not stall the pass", async () => {
    const fake = createKybFake({ merchants: 3, failingMerchant: merchantId(1) });
    const { worker, logger, cursorStore } = buildWorker(fake);
    await worker.runOnce();
    expect(fake.merchants[0]!.status).toBe("ACTIVE");
    expect(fake.merchants[1]!.status).toBe("SUSPENDED");
    expect(logger.errors.some((line) => line.includes(merchantId(1)))).toBe(true);
    expect(await cursorStore.read(KYB_SUSPENSION_CURSOR)).toBe(merchantId(2));
    await worker.runOnce();
    expect(fake.merchants[2]!.status).toBe("SUSPENDED");
  });

  test("the SQL cursor store reads and upserts worker_cursors, and falls back to memory when the table is missing", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const table = new Map<string, string | null>();
    const healthy = new SqlWorkerCursorStore({
      $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
        statements.push({ sql, values });
        const name = String(values[0]);
        return table.has(name) ? [{ cursor_value: table.get(name) }] : [];
      },
      $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
        statements.push({ sql, values });
        table.set(String(values[0]), (values[1] as string | null) ?? null);
        return 1;
      },
    });
    expect(await healthy.read("a")).toBeNull();
    await healthy.write("a", "cursor-1");
    expect(await healthy.read("a")).toBe("cursor-1");
    expect(statements[1]!.sql).toContain("ON CONFLICT (name) DO UPDATE");

    const warnings: string[] = [];
    const missing = new SqlWorkerCursorStore(
      {
        $queryRawUnsafe: async () => {
          throw new Error('relation "worker_cursors" does not exist');
        },
        $executeRawUnsafe: async () => {
          throw new Error('relation "worker_cursors" does not exist');
        },
      },
      { warn: (message) => warnings.push(message) },
    );
    await missing.write("b", "cursor-2");
    expect(await missing.read("b")).toBe("cursor-2");
    await missing.write("b", "cursor-3");
    expect(await missing.read("b")).toBe("cursor-3");
    expect(warnings).toHaveLength(1);
  });
});
