import { describe, expect, test } from "bun:test";
import { Prisma } from "../generated/prisma/client";
import type { DynamicAttemptPatch } from "../engine/flow/DynamicRailEngine";
import { AttemptStateConflictError, PrismaAttemptRepository } from "../engine/runtime/attemptRepository";

/**
 * Regression: `PrismaAttemptRepository.updateAttempt` once forwarded an `adjustmentState` field to
 * `paymentAttempt.update`. `payment_attempts` has no such column, so Prisma rejected the call and
 * every approved refund threw before reaching the gateway. The engine tests did not notice because
 * they use an in-memory attempt repository that accepts any key.
 *
 * This test drives the real repository with a patch that sets every field and checks each key it
 * writes against the generated Prisma model, so a write to a non-existent column fails here
 * instead of in production. It needs no database.
 */

/** Every patch field set. `Required<>` makes the compiler flag a new patch field missing here. */
const everyField: Required<DynamicAttemptPatch> = {
  status: "SUCCEEDED",
  substatus: "FINALIZING",
  clearSubstatus: false,
  canonicalError: "SOME_ERROR",
  otpAttempts: 1,
  pointOfNoReturn: true,
  ledgerEntryId: "00000000-0000-7000-8000-000000000001",
  contextCiphertext: "ciphertext",
  publicOutputs: { a: 1 },
  providerReference: "provider-ref",
  networkReference: "network-ref",
  settledAmount: "10.0000",
  gatewayFeeAmount: "0.5000",
  expectedStatus: "VERIFYING",
};

const capturingClient = (options: { matched?: number } = {}) => {
  const writes: Array<Record<string, unknown>> = [];
  const conditions: Array<Record<string, unknown>> = [];
  const row = {
    id: "attempt-1",
    reference: "ref",
    gatewayReference: null,
    status: "SUCCEEDED",
    substatus: null,
    env: "TEST",
    mode: "OTP_PULL",
    subMode: null,
    currency: "LYD",
    requestedAmount: "10",
    surchargeAmount: "0",
    totalChargedAmount: "10",
    settledAmount: "10",
    gatewayFeeAmount: null,
    providerReference: null,
    networkReference: null,
    otpAttempts: 0,
    expiresAt: null,
    contextCiphertext: "",
    customerFieldsMasked: {},
  };
  const client = {
    paymentAttempt: {
      update: async (args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        return row;
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        conditions.push(args.where);
        writes.push(args.data);
        return { count: options.matched ?? 1 };
      },
      findUnique: async () => row,
    },
    outboxEvent: { create: async () => ({}) },
    $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async () => [],
  };
  return { client, writes, conditions };
};

describe("PrismaAttemptRepository writes only real payment_attempts columns", () => {
  const columns = new Set<string>(Object.values(Prisma.PaymentAttemptScalarFieldEnum));

  test("a patch with every field set maps to existing columns only", async () => {
    const { client, writes } = capturingClient();
    const repository = new PrismaAttemptRepository(client as never);
    await repository.updateAttempt("attempt-1", everyField).catch(() => undefined);

    expect(writes).toHaveLength(1);
    const unknown = Object.keys(writes[0] ?? {}).filter((key) => !columns.has(key));
    expect(unknown).toEqual([]);
  });

  test("payment_attempts has no adjustment-state column (the refund state lives on adjustments)", () => {
    expect(columns.has("adjustmentState")).toBe(false);
    expect(new Set<string>(Object.values(Prisma.AdjustmentScalarFieldEnum)).has("state")).toBe(true);
  });
});

describe("PrismaAttemptRepository status writes are compare-and-set", () => {
  test("a patch with expectedStatus only lands while the row still has that status", async () => {
    const { client, conditions } = capturingClient();
    await new PrismaAttemptRepository(client as never).updateAttempt("attempt-1", { status: "UNKNOWN", expectedStatus: "VERIFYING" });
    expect(conditions).toEqual([{ id: "attempt-1", status: "VERIFYING" }]);
  });

  test("a lost race throws ATTEMPT_STATE_CONFLICT and enqueues nothing", async () => {
    const { client } = capturingClient({ matched: 0 });
    const error = await new PrismaAttemptRepository(client as never)
      .updateAttempt("attempt-1", { status: "FAILED", expectedStatus: "VERIFYING" })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(AttemptStateConflictError);
    expect((error as { code: string }).code).toBe("ATTEMPT_STATE_CONFLICT");
  });

  test("the expected status is a condition, never a written column", async () => {
    const { client, writes } = capturingClient();
    await new PrismaAttemptRepository(client as never).updateAttempt("attempt-1", { status: "UNKNOWN", expectedStatus: "VERIFYING" });
    expect(Object.keys(writes[0] ?? {})).not.toContain("expectedStatus");
  });
});

describe("PrismaAttemptRepository.claimFinalize", () => {
  const claim = async (status: string) => {
    const { client, conditions } = capturingClient();
    await new PrismaAttemptRepository(client as never).claimFinalize("attempt-1", status);
    return conditions[0];
  };

  test("an open attempt is claimed only while it is not terminal", async () => {
    expect(await claim("VERIFYING")).toEqual({ id: "attempt-1", status: "VERIFYING", terminalAt: null });
  });

  // FAILED and EXPIRED always carry terminal_at: requiring it to be NULL made a late success unclaimable,
  // so a verified "paid" callback for such an attempt was refused and dropped.
  test("a late success on a FAILED or EXPIRED attempt is claimable although it is terminal", async () => {
    expect(await claim("FAILED")).toEqual({ id: "attempt-1", status: "FAILED" });
    expect(await claim("EXPIRED")).toEqual({ id: "attempt-1", status: "EXPIRED" });
  });
});
