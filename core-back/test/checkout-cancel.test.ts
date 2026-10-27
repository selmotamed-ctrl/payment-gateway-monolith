import { describe, expect, test } from "bun:test";
import { cancelAttemptAtomically } from "../api/internal/checkout";

interface FakeAttempt {
  id: string;
  linkId: string;
  status: string;
  terminalAt: Date | null;
  pointOfNoReturn: boolean;
  substatus: string | null;
}

const TERMINAL_STATUSES = new Set([
  "SUCCEEDED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
  "BLOCKED",
]);

const createCancelHarness = (options: {
  attempt?: Partial<FakeAttempt>;
  activeLockedCount?: number;
} = {}) => {
  const attempt: FakeAttempt = {
    id: "attempt-1",
    linkId: "link-1",
    status: "AWAITING_CUSTOMER",
    terminalAt: null,
    pointOfNoReturn: false,
    substatus: null,
    ...options.attempt,
  };
  const state = {
    attempt,
    link: { id: "link-1", activeLockedCount: options.activeLockedCount ?? 1 },
    releaseCalls: 0,
    statements: [] as Array<{ sql: string; params: unknown[] }>,
  };

  const tx = {
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      state.statements.push({ sql, params });
      if (sql.includes("UPDATE payment_attempts")) {
        const id = String(params[1]);
        if (id !== attempt.id) {
          return 0;
        }
        const cancellable = attempt.terminalAt === null
          && !attempt.pointOfNoReturn
          && attempt.substatus !== "AML_HOLD"
          && !TERMINAL_STATUSES.has(attempt.status)
          && attempt.status !== "AUTHORIZING";
        if (!cancellable) {
          return 0;
        }
        attempt.status = "CANCELLED";
        attempt.terminalAt = params[0] as Date;
        return 1;
      }
      if (sql.includes("UPDATE payment_links")) {
        state.releaseCalls += 1;
        state.link.activeLockedCount = Math.max(0, state.link.activeLockedCount - 1);
        return 1;
      }
      return 0;
    },
    paymentAttempt: {
      findUnique: async () => ({ status: attempt.status }),
    },
  };
  const db = {
    $transaction: async <T>(callback: (inner: typeof tx) => Promise<T>): Promise<T> => callback(tx),
  };
  return { db: db as never, state };
};

describe("checkout cancel transition", () => {
  test("cancels once, releases once, and a repeat call is idempotent", async () => {
    const harness = createCancelHarness({ activeLockedCount: 1 });

    const first = await cancelAttemptAtomically(harness.db, harness.state.attempt);
    expect(first).toMatchObject({ attemptId: "attempt-1", status: "CANCELLED", released: true });
    expect(harness.state.link.activeLockedCount).toBe(0);
    expect(harness.state.releaseCalls).toBe(1);

    const second = await cancelAttemptAtomically(harness.db, harness.state.attempt);
    expect(second).toMatchObject({ attemptId: "attempt-1", status: "CANCELLED", released: false });
    expect(harness.state.link.activeLockedCount).toBe(0);
    expect(harness.state.releaseCalls).toBe(1);

    const update = harness.state.statements.find((entry) =>
      entry.sql.includes("UPDATE payment_attempts")
    );
    expect(update?.sql).toContain("terminal_at IS NULL");
    expect(update?.sql).toContain("point_of_no_return = 0");
    expect(update?.sql).toContain("status NOT IN");
  });

  test("a repeated cancel cannot free the slot held by a different attempt", async () => {
    const harness = createCancelHarness({
      attempt: {
        status: "CANCELLED",
        terminalAt: new Date("2026-03-01T10:00:00.000Z"),
      },
      activeLockedCount: 1,
    });

    const result = await cancelAttemptAtomically(harness.db, harness.state.attempt);

    expect(result).toMatchObject({ status: "CANCELLED", released: false });
    expect(harness.state.link.activeLockedCount).toBe(1);
    expect(harness.state.releaseCalls).toBe(0);
  });

  test.each([
    ["BLOCKED", new Date("2026-03-01T10:00:00.000Z")],
    ["EXPIRED", new Date("2026-03-01T10:00:00.000Z")],
    ["FAILED", new Date("2026-03-01T10:00:00.000Z")],
  ] as const)("a %s attempt never frees a slot", async (status, terminalAt) => {
    const harness = createCancelHarness({
      attempt: { status, terminalAt },
      activeLockedCount: 1,
    });

    const result = await cancelAttemptAtomically(harness.db, harness.state.attempt);

    expect(result).toMatchObject({ status, released: false });
    expect(harness.state.attempt.status).toBe(status);
    expect(harness.state.link.activeLockedCount).toBe(1);
    expect(harness.state.releaseCalls).toBe(0);
  });

  test("an UNKNOWN attempt past the point of no return cannot be cancelled", async () => {
    const harness = createCancelHarness({
      attempt: { status: "UNKNOWN", terminalAt: null, pointOfNoReturn: true },
      activeLockedCount: 1,
    });

    const result = await cancelAttemptAtomically(harness.db, harness.state.attempt);

    expect(result).toMatchObject({ status: "UNKNOWN", released: false });
    expect(harness.state.attempt.status).toBe("UNKNOWN");
    expect(harness.state.link.activeLockedCount).toBe(1);
    expect(harness.state.releaseCalls).toBe(0);
  });

  test("an UNKNOWN attempt before the point of no return is still cancellable", async () => {
    const harness = createCancelHarness({
      attempt: { status: "UNKNOWN", terminalAt: null, pointOfNoReturn: false },
      activeLockedCount: 1,
    });

    const result = await cancelAttemptAtomically(harness.db, harness.state.attempt);

    expect(result).toMatchObject({ status: "CANCELLED", released: true });
    expect(harness.state.link.activeLockedCount).toBe(0);
    expect(harness.state.releaseCalls).toBe(1);
  });

  test("an AML-held attempt cannot be cancelled and keeps its slot", async () => {
    const harness = createCancelHarness({
      attempt: { status: "CREATED", terminalAt: null, pointOfNoReturn: false, substatus: "AML_HOLD" },
      activeLockedCount: 1,
    });

    const result = await cancelAttemptAtomically(harness.db, harness.state.attempt);

    expect(result).toMatchObject({ status: "CREATED", released: false });
    expect(harness.state.attempt.status).toBe("CREATED");
    expect(harness.state.attempt.terminalAt).toBeNull();
    expect(harness.state.link.activeLockedCount).toBe(1);
    expect(harness.state.releaseCalls).toBe(0);

    const update = harness.state.statements.find((entry) =>
      entry.sql.includes("UPDATE payment_attempts")
    );
    expect(update?.sql).toContain("substatus <> 'AML_HOLD'");
  });
});
