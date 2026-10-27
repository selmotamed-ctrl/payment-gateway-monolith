import { describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import { executeAdjustment } from "../engine/governance/GovernanceExecution";
import { createGovernanceFixture } from "./edge-cases/helpers";
import { fakeTable } from "./helpers/governanceFake";

const refundEntries = (adjustmentId: string) =>
  fakeTable("journalEntry").filter((row) => row.refType === "ADJUSTMENT" && row.refId === adjustmentId);

describe("F-C: three-phase refund execution", () => {
  test("an approved refund never holds the attempt lock across the gateway call and posts once", async () => {
    const { client, context } = createGovernanceFixture();
    client.adjustment.create({
      data: {
        id: "refund-1",
        type: "REFUND",
        targetGlAccountId: "acc-wallet",
        sourceAttemptId: "attempt-1",
        amount: new Decimal(100),
        reverseCommission: true,
        reason: "customer request",
        state: "PENDING_REVIEW",
      },
    });

    // The transaction client and the base client are deliberately different
    // connections: a transaction owns a lock until it commits, while the base
    // client refuses to touch a row that is still locked by an open
    // transaction. This is exactly the deadlock the old code created.
    const openLocks = new Map<number, Set<string>>();
    let connection = 0;
    let gatewayOpenLocks = -1;

    const baseUpdateAttempt = client.paymentAttempt.update.bind(client.paymentAttempt);
    client.paymentAttempt.update = async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      if (openLocks.size > 0) {
        throw new Error("DEADLOCK: the base connection cannot update an attempt locked by a transaction");
      }
      return baseUpdateAttempt(args);
    };

    const buildTransaction = (connectionId: number) => {
      const tx = Object.create(client) as typeof client & {
        $queryRaw: (strings: unknown, ...values: unknown[]) => Promise<unknown[]>;
        $executeRaw: () => Promise<number>;
      };
      for (const delegate of [
        "adjustment",
        "paymentAttempt",
        "rail",
        "railRoute",
        "glAccount",
        "journalEntry",
        "journalLine",
        "auditLog",
        "wallet",
        "merchant",
        "dispute",
        "operatorCase",
        "gatewayVersion",
        "gateway",
        "approvalRequest",
      ]) {
        (tx as Record<string, unknown>)[delegate] = (client as Record<string, unknown>)[delegate];
      }
      tx.$queryRaw = async (strings: unknown, ...values: unknown[]) => {
        const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
        if (/payment_attempts/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          const attemptId = String(values[0]);
          const locks = openLocks.get(connectionId) ?? new Set<string>();
          locks.add(attemptId);
          openLocks.set(connectionId, locks);
          const row = fakeTable("paymentAttempt").find((entry) => entry.id === attemptId);
          return row ? [row] : [];
        }
        return [];
      };
      tx.$executeRaw = async () => 1;
      return tx;
    };

    client.$transaction = async <R>(callback: (tx: never) => Promise<R>): Promise<R> => {
      const connectionId = ++connection;
      const tx = buildTransaction(connectionId);
      try {
        return await callback(tx as never);
      } finally {
        openLocks.delete(connectionId);
      }
    };

    const engine = {
      refund: async () => {
        gatewayOpenLocks = openLocks.size;
        // The real DynamicRailEngine updates the attempt through the base
        // Prisma client, i.e. a different connection from the transaction.
        await client.paymentAttempt.update({
          where: { id: "attempt-1" },
          data: { status: "REFUNDED" },
        });
        return { status: "REFUNDED", attempt: { ownershipMode: "PLATFORM_CLEARING" } };
      },
    };

    const first = await executeAdjustment({ ...context, engine }, client as never, {
      adjustmentId: "refund-1",
      checkerUserId: "user-finance",
      checkerRole: "FINANCE",
    });

    expect(first.status).toBe("EXECUTED");
    expect(first.template).toBe("FULL_REFUND");
    expect(gatewayOpenLocks).toBe(0);
    expect(openLocks.size).toBe(0);
    expect(fakeTable("adjustment")[0]?.state).toBe("EXECUTED");
    expect(refundEntries("refund-1")).toHaveLength(1);

    // A repeated execution is a no-op: the adjustment is already EXECUTED.
    const second = await executeAdjustment({ ...context, engine }, client as never, {
      adjustmentId: "refund-1",
      checkerUserId: "user-finance",
      checkerRole: "FINANCE",
    });

    expect(second.status).toBe("SKIPPED");
    expect(refundEntries("refund-1")).toHaveLength(1);
  });
});
