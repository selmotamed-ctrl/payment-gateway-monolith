import { describe, expect, test } from "bun:test";
import {
  findActiveGatewayInquiry,
  markGatewayInquiryRunning,
  reconcileGatewayInquiries,
  updateGatewayInquiry,
} from "../engine/workers/GatewayInquirySchedules";

const makeDb = (overrides: Record<string, unknown> = {}) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const delegate = {
    findFirst: async (...args: unknown[]) => {
      calls.push({ method: "findFirst", args });
      return overrides.first ?? null;
    },
    findMany: async (...args: unknown[]) => {
      calls.push({ method: "findMany", args });
      return overrides.many ?? [];
    },
    updateMany: async (...args: unknown[]) => {
      calls.push({ method: "updateMany", args });
      return { count: 1 };
    },
    ...((overrides.delegate as Record<string, unknown>) ?? {}),
  };
  return {
    calls,
    db: {
      gatewayInquirySchedule: delegate,
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(delegate),
      $queryRaw: async () => [],
      $executeRaw: async () => 0,
      $queryRawUnsafe: async () => [],
      $executeRawUnsafe: async () => 0,
    } as never,
  };
};

describe("gateway inquiry schedule worker helpers", () => {
  test("is a no-op when the fake database has no schedule delegate", async () => {
    const db = {
      $transaction: async () => undefined,
      $queryRaw: async () => [],
      $executeRaw: async () => 0,
      $queryRawUnsafe: async () => [],
      $executeRawUnsafe: async () => 0,
    } as never;
    expect(await findActiveGatewayInquiry(db, "attempt-1")).toBeNull();
    await markGatewayInquiryRunning(db, "schedule-1", new Date());
    await updateGatewayInquiry(db, "schedule-1", { status: "COMPLETED" });
    await reconcileGatewayInquiries(db, new Date());
  });

  test("marks a schedule running and increments its attempt counter", async () => {
    const { db, calls } = makeDb();
    await markGatewayInquiryRunning(db, "schedule-1", new Date("2026-01-01T00:00:00Z"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("updateMany");
    expect(JSON.stringify(calls[0]?.args)).toContain('"increment":1');
  });

  test("reconciles a terminal attempt to COMPLETED", async () => {
    const { db, calls } = makeDb({
      many: [
        {
          id: "schedule-1",
          status: "SCHEDULED",
          attempt: { status: "SUCCEEDED", terminalAt: new Date(), nextCheckAt: null },
        },
      ],
    });
    await reconcileGatewayInquiries(db, new Date("2026-01-01T00:00:00Z"));
    expect(calls.some((call) => call.method === "updateMany")).toBe(true);
    expect(JSON.stringify(calls)).toContain('"status":"COMPLETED"');
  });

  test("expires a schedule whose polling window elapsed", async () => {
    const { db, calls } = makeDb({
      many: [
        {
          id: "schedule-1",
          status: "RETRYING",
          attempt: { status: "UNKNOWN", terminalAt: null, nextCheckAt: null },
        },
      ],
    });
    await reconcileGatewayInquiries(db, new Date("2026-01-01T00:00:00Z"));
    expect(JSON.stringify(calls)).toContain('"status":"EXPIRED"');
  });
});
