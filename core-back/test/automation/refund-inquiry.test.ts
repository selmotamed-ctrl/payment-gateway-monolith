import { describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import type { BackgroundJobRow, PrismaLike } from "../../engine/db/ports";
import {
  executeAdjustment,
  failReconciledRefundAdjustment,
  finalizeReconciledRefundAdjustment,
} from "../../engine/governance/GovernanceExecution";
import {
  createDbRefundInquiryCaseOpener,
  createDbRefundInquiryJobStore,
  createEngineRefundInquiryPort,
  createGovernanceRefundResolution,
  createRefundInquiryJobHandler,
  createRefundInquiryScheduler,
  findExecutingRefundsWithoutInquiry,
  REFUND_INQUIRY_SUBJECT_KEY,
  type RefundAdjustmentSnapshot,
  type RefundInquiryJobPayload,
  type RefundInquiryJobStore,
  type RefundInquiryOutcome,
} from "../../engine/workers/RefundInquiry";
import { createGovernanceFixture } from "../edge-cases/helpers";
import { fakeTable } from "../helpers/governanceFake";
import { createPool, createPrisma, databaseIsReachable, describeDatabase, uniqueUuid } from "../storage-engine/helpers/db";

const NOW = new Date("2026-11-09T12:00:00Z");
const WINDOW_START = new Date("2026-11-09T11:00:00Z");

const recordingStore = () => {
  const initial: Array<{ payload: RefundInquiryJobPayload; availableAt: Date; maxAttempts: number }> = [];
  const followUps: Array<{ payload: RefundInquiryJobPayload; availableAt: Date; maxAttempts: number }> = [];
  const store: RefundInquiryJobStore = {
    enqueueInitial: async (payload, availableAt, maxAttempts) => {
      initial.push({ payload, availableAt, maxAttempts });
      return true;
    },
    enqueueFollowUp: async (payload, availableAt, maxAttempts) => {
      followUps.push({ payload, availableAt, maxAttempts });
      return true;
    },
  };
  return { store, initial, followUps };
};

const job = (payload: Partial<RefundInquiryJobPayload> = {}): BackgroundJobRow => ({
  id: "job-1",
  jobType: "REFUND_INQUIRY",
  referenceType: "ADJUSTMENT",
  referenceId: "adj-1",
  payloadJson: {
    kind: "REFUND_INQUIRY",
    adjustmentId: "adj-1",
    attemptId: "attempt-1",
    check: 0,
    windowStartedAt: WINDOW_START.toISOString(),
    ...payload,
  },
  state: "RUNNING",
  attempts: 0,
  maxAttempts: 5,
  availableAt: NOW,
  lockedAt: NOW,
  lastError: null,
  completedAt: null,
});

const handlerHarness = (options: {
  state?: string;
  outcome?: RefundInquiryOutcome | Error;
  windowSeconds?: number;
  backoffSeconds?: number[];
} = {}) => {
  const { store, followUps } = recordingStore();
  const inquiries: Array<{ check: number; amount: string }> = [];
  const finalized: Array<{ adjustmentId: string; ownershipMode?: string | null }> = [];
  const failed: Array<{ adjustmentId: string; reason: string }> = [];
  const cases: Array<{ adjustmentId: string; attemptId: string; reason: string }> = [];
  const adjustment: RefundAdjustmentSnapshot = {
    id: "adj-1",
    type: "REFUND",
    state: options.state ?? "EXECUTING",
    sourceAttemptId: "attempt-1",
    amount: "100.0000",
  };
  const handler = createRefundInquiryJobHandler({
    db: {} as PrismaLike,
    clock: () => NOW,
    store,
    adjustments: { find: async () => adjustment },
    inquiry: {
      inquire: async (input) => {
        inquiries.push({ check: input.check, amount: input.amount });
        if (options.outcome instanceof Error) throw options.outcome;
        return options.outcome ?? { status: "UNKNOWN", definitive: false };
      },
    },
    resolution: {
      finalize: async (input) => {
        finalized.push(input);
        return { status: "EXECUTED" };
      },
      fail: async (input) => {
        failed.push(input);
        return { status: "EXECUTED" };
      },
    },
    cases: {
      open: async (input) => {
        cases.push({ adjustmentId: input.adjustmentId, attemptId: input.attemptId, reason: input.reason });
        return { caseId: "case-1", created: cases.length === 1 };
      },
    },
    windowSeconds: options.windowSeconds,
    backoffSeconds: options.backoffSeconds,
  });
  return { handler, followUps, inquiries, finalized, failed, cases };
};

describe("AUTO-20 refund inquiry scheduler (ReconciliationScheduler)", () => {
  test("schedule enqueues the first check of a chain", async () => {
    const { store, initial } = recordingStore();
    const scheduler = createRefundInquiryScheduler({ db: {} as PrismaLike, store, clock: () => NOW, firstCheckAfterSeconds: 30, jobMaxAttempts: 7 });
    await scheduler.schedule("attempt-1", "adj-1");
    expect(initial).toEqual([{
      payload: { kind: "REFUND_INQUIRY", adjustmentId: "adj-1", attemptId: "attempt-1", check: 0, windowStartedAt: NOW.toISOString() },
      availableAt: new Date(NOW.getTime() + 30_000),
      maxAttempts: 7,
    }]);
  });

  test("schedule without an adjustment does nothing, and a store failure never reaches the refund path", async () => {
    const { store, initial } = recordingStore();
    await createRefundInquiryScheduler({ db: {} as PrismaLike, store }).schedule("attempt-1");
    expect(initial).toHaveLength(0);
    const broken = createRefundInquiryScheduler({
      db: {} as PrismaLike,
      store: { enqueueInitial: async () => { throw new Error("db away"); }, enqueueFollowUp: async () => false },
    });
    await expect(broken.schedule("attempt-1", "adj-1")).resolves.toBeUndefined();
  });

  test("the database store inserts a REFUND_INQUIRY job only when no live inquiry exists", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    let live: unknown[] = [];
    const db = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        statements.push({ sql, args });
        return sql.includes("state IN ('QUEUED', 'RUNNING')") ? live : [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        statements.push({ sql, args });
        return 1;
      },
    } as unknown as PrismaLike;
    const store = createDbRefundInquiryJobStore(db, () => NOW);
    const payload: RefundInquiryJobPayload = {
      kind: "REFUND_INQUIRY", adjustmentId: "adj-1", attemptId: "attempt-1", check: 0, windowStartedAt: NOW.toISOString(),
    };

    expect(await store.enqueueInitial(payload, NOW, 5)).toBe(true);
    expect(statements[0]?.sql).toContain("pg_advisory_xact_lock");
    const insert = statements.find((entry) => entry.sql.startsWith("INSERT INTO background_jobs"));
    expect(insert?.sql).toContain("'REFUND_INQUIRY'::\"BackgroundJobType\"");
    expect(insert?.args[2]).toBe("ADJUSTMENT");
    expect(insert?.args[3]).toBe("adj-1");
    expect(JSON.parse(String(insert?.args[4]))).toEqual(payload);

    statements.length = 0;
    live = [{ id: "job-live" }];
    expect(await store.enqueueInitial(payload, NOW, 5)).toBe(false);
    expect(statements.some((entry) => entry.sql.startsWith("INSERT"))).toBe(false);
  });

  test("the governance refund path schedules the inquiry when the gateway answer is UNKNOWN", async () => {
    const { client, context } = createGovernanceFixture();
    client.adjustment.create({
      data: {
        id: "refund-1", type: "REFUND", targetGlAccountId: "acc-wallet", sourceAttemptId: "attempt-1",
        amount: new Decimal(100), reverseCommission: true, reason: "customer request", state: "APPROVED",
      },
    });
    const { store, initial } = recordingStore();
    const result = await executeAdjustment(
      {
        ...context,
        engine: { refund: async () => ({ status: "UNKNOWN" }) },
        reconciliationScheduler: createRefundInquiryScheduler({ db: client as never, store, clock: () => NOW }),
      },
      client as never,
      { adjustmentId: "refund-1", checkerUserId: "user-finance", checkerRole: "FINANCE" },
    );
    expect(result.status).toBe("HELD");
    expect(fakeTable("adjustment")[0]?.state).toBe("EXECUTING");
    expect(initial.map((entry) => [entry.payload.adjustmentId, entry.payload.attemptId])).toEqual([["refund-1", "attempt-1"]]);
  });
});

describe("AUTO-20 REFUND_INQUIRY job handler", () => {
  test("a definitive success finalises the adjustment through governance", async () => {
    const h = handlerHarness({ outcome: { status: "SUCCEEDED", definitive: true, ownershipMode: "PLATFORM_CLEARING" } });
    await h.handler.handle(job());
    expect(h.inquiries).toEqual([{ check: 0, amount: "100.0000" }]);
    expect(h.finalized).toEqual([{ adjustmentId: "adj-1", ownershipMode: "PLATFORM_CLEARING" }]);
    expect(h.failed).toHaveLength(0);
    expect(h.followUps).toHaveLength(0);
    expect(h.cases).toHaveLength(0);
  });

  test("a definitive failure fails the adjustment", async () => {
    const h = handlerHarness({ outcome: { status: "FAILED", definitive: true, detail: "refund declined" } });
    await h.handler.handle(job());
    expect(h.failed).toEqual([{ adjustmentId: "adj-1", reason: "refund declined" }]);
    expect(h.finalized).toHaveLength(0);
  });

  test("an open or non-definitive answer schedules the next check with backoff", async () => {
    for (const outcome of [
      { status: "UNKNOWN", definitive: false } as RefundInquiryOutcome,
      { status: "FAILED", definitive: false } as RefundInquiryOutcome,
      new Error("gateway timeout"),
    ]) {
      const h = handlerHarness({ outcome, backoffSeconds: [60, 600] });
      await h.handler.handle(job({ check: 1 }));
      expect(h.finalized).toHaveLength(0);
      expect(h.failed).toHaveLength(0);
      expect(h.followUps).toHaveLength(1);
      expect(h.followUps[0]?.payload).toMatchObject({ check: 2, windowStartedAt: WINDOW_START.toISOString() });
      expect(h.followUps[0]?.availableAt).toEqual(new Date(NOW.getTime() + 600_000));
    }
  });

  test("the last check is capped at the end of the window", async () => {
    // Window of 1 h 5 min from 11:00 -> ends 12:05; a 1 h backoff is capped there.
    const h = handlerHarness({ windowSeconds: 3_900, backoffSeconds: [3_600] });
    await h.handler.handle(job({ check: 4 }));
    expect(h.followUps[0]?.availableAt).toEqual(new Date("2026-11-09T12:05:00Z"));
  });

  test("when the window elapsed a case is opened and the gateway is not asked again", async () => {
    const h = handlerHarness({ windowSeconds: 3_600 });
    await h.handler.handle(job({ check: 9 }));
    expect(h.inquiries).toHaveLength(0);
    expect(h.followUps).toHaveLength(0);
    expect(h.cases).toHaveLength(1);
    expect(h.cases[0]).toMatchObject({ adjustmentId: "adj-1", attemptId: "attempt-1" });
    expect(h.cases[0]?.reason).toContain("inquiry window");
  });

  test("a rail that cannot be asked goes to an operator at once", async () => {
    const h = handlerHarness({ outcome: { status: "UNKNOWN", definitive: false, supported: false, detail: "no refund inquiry" } });
    await h.handler.handle(job());
    expect(h.cases.map((entry) => entry.reason)).toEqual(["no refund inquiry"]);
    expect(h.followUps).toHaveLength(0);
  });

  test("an adjustment that is no longer EXECUTING is left alone", async () => {
    for (const state of ["EXECUTED", "REJECTED"]) {
      const h = handlerHarness({ state });
      await h.handler.handle(job());
      expect(h.inquiries).toHaveLength(0);
      expect(h.followUps).toHaveLength(0);
      expect(h.cases).toHaveLength(0);
    }
  });

  test("an invalid payload fails the job", async () => {
    const h = handlerHarness();
    await expect(h.handler.handle(job({ windowStartedAt: "not-a-date" }))).rejects.toThrow();
  });
});

describe("AUTO-20 governance resolution and keyed case", () => {
  const seedExecutingRefund = (client: Record<string, any>) =>
    client.adjustment.create({
      data: {
        id: "refund-1", type: "REFUND", targetGlAccountId: "acc-wallet", sourceAttemptId: "attempt-1",
        amount: new Decimal(100), reverseCommission: true, reason: "customer request", state: "EXECUTING",
      },
    });

  test("finalising a reconciled refund books it once", async () => {
    const { client, context } = createGovernanceFixture();
    seedExecutingRefund(client);
    const input = { adjustmentId: "refund-1", actorUserId: "user-finance", actorRole: "SYSTEM" };
    const first = await finalizeReconciledRefundAdjustment(context, client as never, input, { status: "REFUNDED" });
    const second = await finalizeReconciledRefundAdjustment(context, client as never, input, { status: "REFUNDED" });
    expect(first.status).toBe("EXECUTED");
    expect(first.template).toBe("FULL_REFUND");
    expect(second.status).toBe("SKIPPED");
    expect(fakeTable("adjustment")[0]?.state).toBe("EXECUTED");
    expect(fakeTable("journalEntry").filter((row) => row.refType === "ADJUSTMENT" && row.refId === "refund-1")).toHaveLength(1);
  });

  test("failing a reconciled refund rejects it without a posting and audits it", async () => {
    const { client, context } = createGovernanceFixture();
    seedExecutingRefund(client);
    const input = { adjustmentId: "refund-1", actorUserId: "user-finance", actorRole: "SYSTEM", reason: "declined" };
    const first = await failReconciledRefundAdjustment(context, client as never, input);
    const second = await failReconciledRefundAdjustment(context, client as never, input);
    expect(first.status).toBe("EXECUTED");
    expect(second.status).toBe("SKIPPED");
    expect(fakeTable("adjustment")[0]?.state).toBe("REJECTED");
    expect(fakeTable("journalEntry").filter((row) => row.refId === "refund-1")).toHaveLength(0);
    expect(fakeTable("auditLog").filter((row) => row.action === "ADJUSTMENT_REFUND_FAILED")).toHaveLength(1);
  });

  test("the handler with the governance resolution books a confirmed refund as the system principal", async () => {
    const { client, context } = createGovernanceFixture();
    seedExecutingRefund(client);
    const handler = createRefundInquiryJobHandler({
      db: client as never,
      clock: () => NOW,
      store: recordingStore().store,
      adjustments: {
        find: async (id) => {
          const row = fakeTable("adjustment").find((entry) => entry.id === id);
          return row
            ? { id, type: String(row.type), state: String(row.state), sourceAttemptId: "attempt-1", amount: "100.0000" }
            : null;
        },
      },
      inquiry: { inquire: async () => ({ status: "SUCCEEDED", definitive: true }) },
      resolution: createGovernanceRefundResolution({ db: client as never, ledgerPoster: context.ledgerPoster, repositories: context.repositories }),
      cases: { open: async () => { throw new Error("no case expected"); } },
    });
    await handler.handle(job({ adjustmentId: "refund-1" }));
    expect(fakeTable("adjustment")[0]?.state).toBe("EXECUTED");
    const audit = fakeTable("auditLog").find((row) => row.action === "ADJUSTMENT_EXECUTED");
    expect(audit?.role).toBe("SYSTEM");
  });

  test("the inquiry case is keyed per adjustment and audited once", async () => {
    const { client } = createGovernanceFixture();
    const opener = createDbRefundInquiryCaseOpener({ db: client as never, slaHours: 8 });
    const first = await opener.open({ adjustmentId: "refund-1", attemptId: "attempt-1", reason: "window elapsed", now: NOW });
    const second = await opener.open({ adjustmentId: "refund-1", attemptId: "attempt-1", reason: "window elapsed", now: NOW });
    expect(first.created).toBe(true);
    expect(second).toEqual({ caseId: first.caseId, created: false });
    const cases = fakeTable("operatorCase").filter((row) => row.subjectKey === REFUND_INQUIRY_SUBJECT_KEY("refund-1"));
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ kind: "MANUAL_REVIEW", priority: "P1", attemptId: "attempt-1", slaDueAt: new Date(NOW.getTime() + 8 * 3_600_000) });
    expect(fakeTable("auditLog").filter((row) => row.action === "REFUND_INQUIRY_ESCALATED")).toHaveLength(1);
  });
});

describe("AUTO-20 engine inquiry port", () => {
  const dbWithRail = (capabilities: unknown) =>
    ({ $queryRawUnsafe: async () => [{ id: "attempt-1", capabilities }] }) as unknown as PrismaLike;

  test("a rail without an idempotent refund replay is reported as unsupported and never re-refunded", async () => {
    let refunds = 0;
    const port = createEngineRefundInquiryPort({
      db: dbWithRail({ refund: true }),
      engine: { refund: async () => { refunds += 1; return { status: "REFUNDED" }; } },
    });
    const outcome = await port.inquire({ adjustmentId: "adj-1", attemptId: "attempt-1", amount: "10.0000", check: 0 });
    expect(outcome).toMatchObject({ status: "UNKNOWN", definitive: false, supported: false });
    expect(refunds).toBe(0);
  });

  test("an idempotent rail is asked by replaying the refund with the same adjustment id", async () => {
    const calls: Array<{ attempt: unknown; amount: string; adjustmentId: string }> = [];
    let answer = "REFUNDED";
    const port = createEngineRefundInquiryPort({
      db: dbWithRail({ refund: true, refund_idempotent: true }),
      engine: {
        refund: async (attempt, amount, adjustmentId) => {
          calls.push({ attempt, amount: amount.toFixed(4), adjustmentId });
          return { status: answer, attempt: { ownershipMode: "MERCHANT_DIRECT" } };
        },
      },
    });
    const confirmed = await port.inquire({ adjustmentId: "adj-1", attemptId: "attempt-1", amount: "10.0000", check: 0 });
    expect(confirmed).toEqual({ status: "SUCCEEDED", definitive: true, ownershipMode: "MERCHANT_DIRECT" });
    expect(calls).toEqual([{ attempt: { id: "attempt-1" }, amount: "10.0000", adjustmentId: "adj-1" }]);
    answer = "FAILED";
    const open = await port.inquire({ adjustmentId: "adj-1", attemptId: "attempt-1", amount: "10.0000", check: 1 });
    expect(open).toMatchObject({ status: "UNKNOWN", definitive: false });
  });
});

const refundInquiryEnumExists = databaseIsReachable
  ? await (async () => {
      const pool = createPool({ max: 1 });
      try {
        const result = await pool.query(
          "SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'BackgroundJobType' AND e.enumlabel = 'REFUND_INQUIRY'",
        );
        return (result.rowCount ?? 0) > 0;
      } catch {
        return false;
      } finally {
        await pool.end().catch(() => undefined);
      }
    })()
  : false;

describeDatabase("AUTO-20 against PostgreSQL", () => {
  test("the monitor query for EXECUTING refunds without an inquiry runs", async () => {
    const prisma = createPrisma({ max: 2 });
    try {
      const rows = await findExecutingRefundsWithoutInquiry(prisma as never, { olderThanMinutes: 15, limit: 5 });
      expect(rows.length).toBeLessThanOrEqual(5);
    } finally {
      await prisma.$disconnect();
    }
  });

  test.skipIf(!refundInquiryEnumExists)("the job store keeps one live inquiry per adjustment and one job per check", async () => {
    const prisma = createPrisma({ max: 2 });
    const adjustmentId = uniqueUuid();
    const store = createDbRefundInquiryJobStore(prisma as never);
    const payload: RefundInquiryJobPayload = {
      kind: "REFUND_INQUIRY", adjustmentId, attemptId: uniqueUuid(), check: 0, windowStartedAt: new Date().toISOString(),
    };
    try {
      expect(await store.enqueueInitial(payload, new Date(), 5)).toBe(true);
      expect(await store.enqueueInitial(payload, new Date(), 5)).toBe(false);
      expect(await store.enqueueFollowUp({ ...payload, check: 1 }, new Date(), 5)).toBe(true);
      expect(await store.enqueueFollowUp({ ...payload, check: 1 }, new Date(), 5)).toBe(false);
      const count = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        "SELECT count(*)::int AS n FROM background_jobs WHERE reference_type = 'ADJUSTMENT' AND reference_id = $1",
        adjustmentId,
      );
      expect(count[0]?.n).toBe(2);
    } finally {
      await prisma.$executeRawUnsafe("DELETE FROM background_jobs WHERE reference_id = $1", adjustmentId).catch(() => undefined);
      await prisma.$disconnect();
    }
  });
});

describe("AUTO-20 platform monitor check", () => {
  test("reports EXECUTING refunds that no inquiry covers", async () => {
    const { createUnscheduledRefundMonitorCheck } = await import("../../engine/workers/moneyPathMonitorChecks");
    let rows: unknown[] = [{ id: "adj-9", source_attempt_id: "attempt-9", amount: "5.0000", updated_at: NOW }];
    const calls: string[] = [];
    const db = {
      $queryRawUnsafe: async (sql: string) => {
        calls.push(sql);
        return rows;
      },
    } as unknown as PrismaLike;
    const check = createUnscheduledRefundMonitorCheck();
    const context = { db, now: NOW, registry: {} as never, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } };
    const findings = (await check.run(context)) as Array<{ detail: string }>;
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("adj-9");
    expect(calls[0]).toContain("job_type::text = 'REFUND_INQUIRY'");
    expect(calls[0]).toContain("'refund.inquiry:' || a.id::text");
    rows = [];
    expect(await check.run(context)).toEqual([]);
  });
});

describe("AUTO-20 dry run", () => {
  test("a definitive answer is audited and handed to an operator instead of being applied", async () => {
    for (const status of ["SUCCEEDED", "FAILED"] as const) {
      const audits: Array<{ action: string; after?: unknown }> = [];
      const cases: string[] = [];
      let resolved = 0;
      const handler = createRefundInquiryJobHandler({
        db: {} as PrismaLike,
        clock: () => NOW,
        dryRun: true,
        audit: async (input) => { audits.push(input); },
        store: recordingStore().store,
        adjustments: { find: async () => ({ id: "adj-1", type: "REFUND", state: "EXECUTING", sourceAttemptId: "attempt-1", amount: "1.0000" }) },
        inquiry: { inquire: async () => ({ status, definitive: true }) },
        resolution: {
          finalize: async () => { resolved += 1; return { status: "EXECUTED" }; },
          fail: async () => { resolved += 1; return { status: "EXECUTED" }; },
        },
        cases: { open: async (input) => { cases.push(input.reason); return { caseId: "c", created: true }; } },
      });
      await handler.handle(job());
      expect(resolved).toBe(0);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.action).toBe("REFUND_INQUIRY_DRY_RUN");
      expect(audits[0]?.after).toMatchObject({ wouldDo: status === "SUCCEEDED" ? "FINALIZE" : "FAIL" });
      expect(cases).toHaveLength(1);
      expect(cases[0]).toContain("dry run");
    }
  });
});
