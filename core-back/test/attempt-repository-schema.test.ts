import { describe, expect, test } from "bun:test";
import { Prisma } from "../generated/prisma/client";
import type { DynamicAttemptPatch } from "../engine/flow/DynamicRailEngine";
import { PrismaAttemptRepository } from "../engine/runtime/attemptRepository";

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
};

const capturingClient = () => {
  const writes: Array<Record<string, unknown>> = [];
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
    },
    outboxEvent: { create: async () => ({}) },
    $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async () => [],
  };
  return { client, writes };
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
