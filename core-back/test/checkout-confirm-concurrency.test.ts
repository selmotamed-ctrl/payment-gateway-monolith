import { describe, expect, test } from "bun:test";
import {
  claimAttemptForConfirm,
  confirmIdempotencyHash,
} from "../api/internal/checkout";
import {
  DynamicRailEngine,
  type DynamicAttempt,
  type DynamicRailEngineOptions,
  type FlowPhase,
} from "../engine/flow/DynamicRailEngine";
import type { FlowStep, StepExecutionResult } from "../engine/flow/StepExecutor";

const CLAIMABLE = new Set(["CREATED", "INITIATING", "AWAITING_CUSTOMER", "VERIFYING", "UNKNOWN"]);

interface FakeAttempt {
  id: string;
  reference: string;
  gatewayReference: string;
  status: string;
  terminalAt: Date | null;
  pointOfNoReturn: boolean;
  substatus: string | null;
  customerFieldsMasked: Record<string, unknown>;
}

const createAttempt = (): FakeAttempt => ({
  id: "attempt-1",
  reference: "PA-1",
  gatewayReference: "GW-1",
  status: "AWAITING_CUSTOMER",
  terminalAt: null,
  pointOfNoReturn: false,
  substatus: null,
  customerFieldsMasked: {},
});

const snapshot = (attempt: FakeAttempt): DynamicAttempt => ({
  id: attempt.id,
  reference: attempt.reference,
  gatewayReference: attempt.gatewayReference,
  status: attempt.status as DynamicAttempt["status"],
  substatus: attempt.substatus ?? undefined,
  pointOfNoReturn: attempt.pointOfNoReturn,
  env: "SANDBOX",
  currency: "LYD",
  requestedAmount: "100.0000",
  totalChargedAmount: "100.0000",
  platformCommissionAmount: "3.0000",
  netMerchantAmount: "97.0000",
  maxOtpAttempts: 3,
  otpAttempts: 0,
  ownershipMode: "PLATFORM_CLEARING",
  context: {},
});

/**
 * Models the conditional claim of `payment_attempts` in memory. The SQL is the
 * statement written by the production helper; the fake applies the same
 * condition so the two concurrent callers race honestly.
 */
const createClaimDb = (attempt: FakeAttempt) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      calls.push({ sql, params });
      if (!sql.includes("UPDATE payment_attempts") || !sql.includes("AUTHORIZING")) {
        return 0;
      }
      const keyHash = String(params[0]);
      const id = String(params[1]);
      if (id !== attempt.id || attempt.terminalAt !== null) {
        return 0;
      }
      if (!CLAIMABLE.has(attempt.status)) {
        return 0;
      }
      if (attempt.status === "UNKNOWN" && attempt.pointOfNoReturn) {
        return 0;
      }
      if (attempt.substatus === "AML_HOLD") {
        return 0;
      }
      if (attempt.customerFieldsMasked.confirm_idempotency_key_hash === keyHash) {
        return 0;
      }
      attempt.status = "AUTHORIZING";
      attempt.pointOfNoReturn = true;
      attempt.customerFieldsMasked.confirm_idempotency_key_hash = keyHash;
      return 1;
    },
  };
  return { db: db as never, calls };
};

const createHarness = (options: {
  executor?: (step: FlowStep) => StepExecutionResult;
  interleave?: boolean;
} = {}) => {
  const attempt = createAttempt();
  const claim = createClaimDb(attempt);
  let initialReads = 0;
  const waiting: Array<() => void> = [];
  const stats = {
    submits: 0,
    journals: 0,
    commits: 0,
    releases: 0,
  };

  const getAttempt = async (id: string): Promise<DynamicAttempt | null> => {
    if (id !== attempt.id) {
      return null;
    }
    const value = snapshot(attempt);
    if (options.interleave === true && initialReads < 2) {
      initialReads += 1;
      // Both concurrent confirms read AWAITING_CUSTOMER before either claims.
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 2) {
          for (const release of waiting.splice(0)) {
            release();
          }
        }
      });
    }
    return value;
  };

  const steps: Partial<Record<FlowPhase, FlowStep[]>> = {
    SUBMIT: [{ id: "submit-step", type: "HTTP", side_effect: "MOVES_MONEY" }],
  };

  const engineOptions: DynamicRailEngineOptions = {
    attempts: {
      getAttempt,
      updateAttempt: async (id, patch) => {
        Object.assign(attempt, patch);
        return snapshot(attempt);
      },
    },
    slots: {
      reserveSlot: async () => ({ reservationId: "slot-1" }),
      releaseSlot: async () => {
        stats.releases += 1;
      },
      commitSlot: async () => {
        stats.commits += 1;
        return { outcome: "COMMITTED", journalEntryId: "entry-1" };
      },
    },
    flowProvider: {
      getSteps: async (phase) => steps[phase] ?? [],
    },
    stepExecutor: {
      execute: async (step: FlowStep) => {
        stats.submits += 1;
        return options.executor
          ? options.executor(step)
          : {
            stepId: step.id,
            status: "SUCCEEDED",
            response: {
              status: "SUCCESS",
              reference: "GW-1",
              amount: "100.0000",
              currency: "LYD",
              environment: "SANDBOX",
            },
            output: { state: {}, public: {} },
            logs: [],
          };
      },
    } as never,
    ledgerPoster: {
      postPaymentConfirmation: async () => {
        stats.journals += 1;
        return { entry: { id: "entry-1" } };
      },
      postScenario: async () => {
        stats.journals += 1;
        return { entry: { id: "entry-1" } };
      },
    },
  };

  const engine = new DynamicRailEngine(engineOptions);
  const confirm = (idempotencyKey: string) =>
    engine.confirm(snapshot(attempt), { otp: "1234" }, {
      claim: async (id) =>
        (await claimAttemptForConfirm(
          claim.db,
          id,
          confirmIdempotencyHash(idempotencyKey),
        )).claimed,
    });

  return { engine, attempt, claim, stats, confirm };
};

describe("checkout confirm concurrency", () => {
  test("two concurrent confirms submit once, post one journal and commit one slot", async () => {
    const harness = createHarness({ interleave: true });
    const [first, second] = await Promise.all([
      harness.confirm("confirm-idem-1"),
      harness.confirm("confirm-idem-1"),
    ]);

    expect(first.status).toBe("SUCCEEDED");
    expect(harness.attempt.status).toBe("SUCCEEDED");
    expect([first.status, second.status]).toContain("SUCCEEDED");
    expect(harness.stats.submits).toBe(1);
    expect(harness.stats.journals).toBe(1);
    expect(harness.stats.commits).toBe(1);
    expect(harness.stats.releases).toBe(0);

    const claimStatement = harness.claim.calls.find((call) =>
      call.sql.includes("UPDATE payment_attempts")
    );
    expect(claimStatement?.sql).toContain("status IN");
    expect(claimStatement?.sql).toContain("terminal_at IS NULL");
    expect(claimStatement?.sql).toContain("AUTHORIZING");
    expect(claimStatement?.sql).toContain("point_of_no_return = 1");
    expect(claimStatement?.params[0]).toBe(confirmIdempotencyHash("confirm-idem-1"));
  });

  test("a duplicate idempotency key is not resubmitted after a retryable OTP outcome", async () => {
    const harness = createHarness({
      executor: (step) => ({
        stepId: step.id,
        status: "AWAITING_CUSTOMER",
        canonicalError: "RETRYABLE_OTP",
        output: { state: {}, public: {} },
        logs: [],
      }),
    });

    const first = await harness.confirm("confirm-retry-key");
    expect(first.status).toBe("AWAITING_CUSTOMER");
    expect(first.canonicalError).toBe("RETRYABLE_OTP");
    expect(harness.stats.submits).toBe(1);

    const duplicate = await harness.confirm("confirm-retry-key");
    expect(duplicate.status).toBe("AWAITING_CUSTOMER");
    expect(harness.stats.submits).toBe(1);

    // A new customer action (new key) may retry the retryable OTP.
    await harness.confirm("confirm-retry-key-2");
    expect(harness.stats.submits).toBe(2);
  });

  test("a duplicate key after an UNKNOWN submit returns the state without resubmitting", async () => {
    const harness = createHarness({
      executor: (step) => ({
        stepId: step.id,
        status: "UNKNOWN",
        output: { state: {}, public: {} },
        logs: [],
      }),
    });

    const first = await harness.confirm("confirm-unknown-key");
    expect(first.status).toBe("UNKNOWN");
    expect(harness.stats.submits).toBe(1);

    const duplicate = await harness.confirm("confirm-unknown-key");
    expect(duplicate.status).toBe("UNKNOWN");
    expect(harness.stats.submits).toBe(1);
    expect(harness.stats.journals).toBe(0);
    expect(harness.stats.commits).toBe(0);
  });

  test("an AML-held attempt is not claimable for SUBMIT", async () => {
    const harness = createHarness();
    harness.attempt.status = "CREATED";
    harness.attempt.substatus = "AML_HOLD";

    const result = await harness.confirm("confirm-held-key");

    expect(result.status).toBe("CREATED");
    expect(harness.stats.submits).toBe(0);
    expect(harness.stats.journals).toBe(0);
    expect(harness.stats.commits).toBe(0);
  });
});
