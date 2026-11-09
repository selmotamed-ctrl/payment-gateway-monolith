import { describe, expect, test } from "bun:test";
import type { PaymentAttemptRow, PrismaLike, Repositories, Tx } from "../../engine/db/ports";
import { PollWorker } from "../../engine/workers/PollWorker";
import {
  checkStaleUnknownAttempts,
  createUnknownAttemptEscalator,
  UNKNOWN_ATTEMPT_SUBJECT_KEY,
  type UnknownAttemptEscalator,
} from "../../engine/workers/StaleUnknownAttempts";
import { emptyRepositories } from "../helpers/fakeRepositories";
import { createFakePrisma, fakeTable, resetFakeDatabase } from "../helpers/governanceFake";
import { openKeyedOperatorCase } from "../../engine/workers/automationCases";
import { createPrisma, describeDatabase, uniqueId } from "../storage-engine/helpers/db";

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const NOW = new Date("2026-11-09T12:00:00Z");

interface Harness {
  db: PrismaLike;
  repositories: Repositories;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  executed: string[];
  scheduleUpdates: Array<Record<string, unknown>>;
}

/** One claimed attempt; the claim statement returns it, everything else is recorded. */
const harness = (
  attempt: Record<string, unknown>,
  schedule: Record<string, unknown> | null = null,
): Harness => {
  const updates: Harness["updates"] = [];
  const executed: string[] = [];
  const scheduleUpdates: Array<Record<string, unknown>> = [];
  const db: PrismaLike = {
    $transaction: async (callback: (tx: Tx) => Promise<unknown>) => callback(db),
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    $queryRawUnsafe: async (sql: string) => (sql.includes("FOR UPDATE SKIP LOCKED") ? [attempt] : []),
    $executeRawUnsafe: async (sql: string) => {
      executed.push(sql);
      return 1;
    },
    gatewayInquirySchedule: {
      findFirst: async () => schedule,
      findMany: async () => [],
      updateMany: async (args: { data: Record<string, unknown> }) => {
        scheduleUpdates.push(args.data);
        return { count: 1 };
      },
    },
  };
  const repositories = emptyRepositories();
  repositories.payments.updateAttempt = async (_tx, id, patch) => {
    updates.push({ id, patch: patch as Record<string, unknown> });
    return { id } as PaymentAttemptRow;
  };
  return { db, repositories, updates, executed, scheduleUpdates };
};

const staleAttempt = (status: string): Record<string, unknown> => ({
  id: "attempt-1",
  status,
  route_id: "route-1",
  link_id: "link-1",
  created_at: new Date(NOW.getTime() - 60 * 60 * 1000), // 1 h > the 900 s default window
  terminal_at: null,
});

const recordingEscalator = (behaviour: "ok" | "throw" = "ok") => {
  const calls: Array<{ attemptId: string; reason: string }> = [];
  const escalator: UnknownAttemptEscalator = {
    escalate: async (attempt, context) => {
      calls.push({ attemptId: attempt.id, reason: context.reason });
      if (behaviour === "throw") throw new Error("database away");
      return { caseId: "case-1", created: calls.length === 1 };
    },
  };
  return { calls, escalator };
};

describe("AUTO-19 PollWorker hands stale UNKNOWN attempts to an operator", () => {
  test("an UNKNOWN attempt whose window elapsed opens one case and is never failed", async () => {
    const h = harness(staleAttempt("UNKNOWN"));
    const { calls, escalator } = recordingEscalator();
    const inquired: string[] = [];
    await new PollWorker({
      db: h.db,
      repositories: h.repositories,
      clock: () => NOW,
      logger: quietLogger,
      unknownEscalator: escalator,
      inquiry: { inquire: async (attempt) => { inquired.push(attempt.id); return { status: "FAILED", definitive: true }; } },
    }).runOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.attemptId).toBe("attempt-1");
    expect(calls[0]?.reason).toContain("polling window elapsed");
    // The polling loop is left; the status is untouched and no terminal transition ran.
    expect(h.updates).toEqual([{ id: "attempt-1", patch: { nextCheckAt: null } }]);
    expect(h.executed.some((sql) => sql.includes("terminal_at ="))).toBe(false);
    expect(inquired).toEqual([]);
  });

  test("the inquiry schedule of an escalated attempt is expired as before", async () => {
    const h = harness(staleAttempt("UNKNOWN"), {
      id: "schedule-1",
      status: "RETRYING",
      windowStartedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    });
    const { calls, escalator } = recordingEscalator();
    await new PollWorker({ db: h.db, repositories: h.repositories, clock: () => NOW, logger: quietLogger, unknownEscalator: escalator }).runOnce();
    expect(calls).toHaveLength(1);
    expect(h.scheduleUpdates.at(-1)?.status).toBe("EXPIRED");
  });

  test("an attempt that is not UNKNOWN keeps the old behaviour (no case)", async () => {
    const h = harness(staleAttempt("VERIFYING"));
    const { calls, escalator } = recordingEscalator();
    await new PollWorker({ db: h.db, repositories: h.repositories, clock: () => NOW, logger: quietLogger, unknownEscalator: escalator }).runOnce();
    expect(calls).toHaveLength(0);
    expect(h.updates).toEqual([{ id: "attempt-1", patch: { nextCheckAt: null } }]);
  });

  test("a failed escalation keeps the attempt due instead of dropping it silently", async () => {
    const h = harness(staleAttempt("UNKNOWN"));
    const { calls, escalator } = recordingEscalator("throw");
    await new PollWorker({
      db: h.db,
      repositories: h.repositories,
      clock: () => NOW,
      logger: quietLogger,
      unknownEscalator: escalator,
      unknownEscalationRetrySeconds: 120,
    }).runOnce();
    expect(calls).toHaveLength(1);
    expect(h.updates).toEqual([{ id: "attempt-1", patch: { nextCheckAt: new Date(NOW.getTime() + 120_000) } }]);
  });
});

describe("AUTO-19 database escalator", () => {
  const attempt = { id: "attempt-9", status: "UNKNOWN" } as PaymentAttemptRow;

  test("opens exactly one keyed UNKNOWN case with an SLA and audits it once", async () => {
    resetFakeDatabase();
    const db = createFakePrisma();
    const escalator = createUnknownAttemptEscalator({ db: db as never, slaHours: 12, priority: "P2" });
    const first = await escalator.escalate(attempt, { now: NOW, reason: "window elapsed" });
    const second = await escalator.escalate(attempt, { now: NOW, reason: "window elapsed" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.caseId).toBe(first.caseId);
    const cases = fakeTable("operatorCase");
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      kind: "UNKNOWN",
      priority: "P2",
      state: "OPEN",
      attemptId: "attempt-9",
      subjectKey: UNKNOWN_ATTEMPT_SUBJECT_KEY("attempt-9"),
      slaDueAt: new Date(NOW.getTime() + 12 * 3_600_000),
    });
    const audits = fakeTable("auditLog").filter((row) => row.action === "ATTEMPT_UNKNOWN_ESCALATED");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ role: "SYSTEM", entityType: "PAYMENT_ATTEMPT", entityId: "attempt-9" });
  });

  test("an open UNKNOWN case the engine already raised for the attempt is reused", async () => {
    resetFakeDatabase();
    const db = createFakePrisma();
    fakeTable("operatorCase").push({ id: "engine-case", kind: "UNKNOWN", attemptId: "attempt-9", state: "IN_PROGRESS" });
    const result = await createUnknownAttemptEscalator({ db: db as never }).escalate(attempt, { now: NOW, reason: "x" });
    expect(result).toEqual({ caseId: "engine-case", created: false });
    expect(fakeTable("operatorCase")).toHaveLength(1);
  });

  test("a resolved case does not suppress a new escalation", async () => {
    resetFakeDatabase();
    const db = createFakePrisma();
    fakeTable("operatorCase").push({
      id: "old-case",
      kind: "UNKNOWN",
      attemptId: "attempt-9",
      subjectKey: UNKNOWN_ATTEMPT_SUBJECT_KEY("attempt-9"),
      state: "RESOLVED",
    });
    const result = await createUnknownAttemptEscalator({ db: db as never }).escalate(attempt, { now: NOW, reason: "x" });
    expect(result.created).toBe(true);
    expect(fakeTable("operatorCase").filter((row) => row.state === "OPEN")).toHaveLength(1);
  });
});

describe("AUTO-19 stale UNKNOWN check helper", () => {
  test("counts and lists UNKNOWN attempts older than the threshold", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const created = new Date(NOW.getTime() - 30 * 3_600_000);
    const db = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args });
        if (sql.includes("count(*)")) {
          return [{ total: 3, without_case: 1, oldest: created }];
        }
        return [
          { id: "a-1", merchant_id: "m-1", route_id: "r-1", link_id: "l-1", created_at: created, has_open_case: true },
          { id: "a-2", merchant_id: "m-1", route_id: "r-1", link_id: null, created_at: created, has_open_case: false },
        ];
      },
    } as unknown as PrismaLike;

    const result = await checkStaleUnknownAttempts(db, { olderThanHours: 24, limit: 2, now: NOW });

    expect(result.count).toBe(3);
    expect(result.withoutCase).toBe(1);
    expect(result.thresholdHours).toBe(24);
    expect(result.oldestAgeMs).toBe(30 * 3_600_000);
    expect(result.attempts.map((row) => [row.id, row.hasOpenCase])).toEqual([["a-1", true], ["a-2", false]]);
    expect(calls.every((call) => call.sql.includes("status = 'UNKNOWN'") && call.sql.includes("terminal_at IS NULL"))).toBe(true);
    expect(calls[0]?.args[0]).toEqual(new Date(NOW.getTime() - 24 * 3_600_000));
    expect(calls[1]?.args[1]).toBe(2);
  });

  test("reports an empty population", async () => {
    const db = {
      $queryRawUnsafe: async (sql: string) => (sql.includes("count(*)") ? [{ total: 0, without_case: 0, oldest: null }] : []),
    } as unknown as PrismaLike;
    const result = await checkStaleUnknownAttempts(db, { now: NOW });
    expect(result).toEqual({ thresholdHours: 24, count: 0, withoutCase: 0, oldestAgeMs: null, attempts: [] });
  });
});

describeDatabase("AUTO-19 against PostgreSQL", () => {
  test("the stale UNKNOWN queries run and keyed cases are unique among unresolved ones", async () => {
    const prisma = createPrisma({ max: 2 });
    const subjectKey = uniqueId("auto19");
    try {
      const check = await checkStaleUnknownAttempts(prisma as never, { olderThanHours: 24, limit: 5 });
      expect(check.count).toBeGreaterThanOrEqual(0);
      expect(check.attempts.length).toBeLessThanOrEqual(5);

      const input = { kind: "UNKNOWN" as const, priority: "P1" as const, subjectKey, notes: "auto-19 test", slaHours: 24 };
      const first = await openKeyedOperatorCase(prisma as never, input);
      const second = await openKeyedOperatorCase(prisma as never, input);
      expect(first.created).toBe(true);
      expect(second).toEqual({ id: first.id, created: false });
    } finally {
      await prisma.operatorCase.deleteMany({ where: { subjectKey } }).catch(() => undefined);
      await prisma.$disconnect();
    }
  });
});

describe("AUTO-19 platform monitor check", () => {
  test("trips while stale UNKNOWN attempts exist and clears when none are left", async () => {
    const { createStaleUnknownMonitorCheck } = await import("../../engine/workers/moneyPathMonitorChecks");
    let total = 2;
    const db = {
      $queryRawUnsafe: async (sql: string) =>
        sql.includes("count(*)")
          ? [{ total, without_case: total, oldest: total ? new Date(NOW.getTime() - 26 * 3_600_000) : null }]
          : total ? [{ id: "a-1", created_at: new Date(NOW.getTime() - 26 * 3_600_000), has_open_case: false }] : [],
    } as unknown as PrismaLike;
    const check = createStaleUnknownMonitorCheck();
    const context = { db, now: NOW, registry: {} as never, logger: quietLogger };
    const tripped = (await check.run(context)) as Array<{ title: string; priority?: string }>;
    expect(check.id).toBe("stale_unknown");
    expect(tripped).toHaveLength(1);
    expect(tripped[0]?.priority).toBe("P1");
    expect(tripped[0]?.title).toContain("2 payment attempt(s)");
    total = 0;
    expect(await check.run(context)).toEqual([]);
  });
});
