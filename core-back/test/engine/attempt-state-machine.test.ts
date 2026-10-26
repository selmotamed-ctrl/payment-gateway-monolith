import { describe, expect, test } from "bun:test";
import {
  DynamicRailEngine,
  type DynamicAttempt,
  type DynamicRailEngineOptions,
} from "../../engine/flow/DynamicRailEngine";
import type { FlowStep } from "../../engine/flow/StepExecutor";

const createAttempt = (overrides: Partial<DynamicAttempt> = {}): DynamicAttempt => ({
  id: "attempt-1",
  reference: "PA-1",
  gatewayReference: "GW-1",
  status: "CREATED",
  env: "SANDBOX",
  currency: "LYD",
  requestedAmount: "100",
  totalChargedAmount: "100",
  platformCommissionAmount: "3.0000",
  netMerchantAmount: "97.0000",
  maxOtpAttempts: 3,
  otpAttempts: 0,
  ownershipMode: "PLATFORM_CLEARING",
  context: {},
  ...overrides,
});

interface Harness {
  engine: DynamicRailEngine;
  attempts: Map<string, DynamicAttempt>;
  reserved: string[];
  released: string[];
  committed: string[];
  stepsByPhase: Map<string, FlowStep[]>;
}

const SUBMIT_STEP: FlowStep = { id: "submit-step", type: "HTTP", side_effect: "MOVES_MONEY" };

const createHarness = (
  options: {
    stepsByPhase?: Map<string, FlowStep[]>;
    ledger?: { entry: { id: string } };
  } = {},
): Harness => {
  const attempts = new Map<string, DynamicAttempt>();
  const reserved: string[] = [];
  const released: string[] = [];
  const committed: string[] = [];
  const stepsByPhase = options.stepsByPhase ?? new Map<string, FlowStep[]>([["SUBMIT", [SUBMIT_STEP]]]);

  const engineOptions: DynamicRailEngineOptions = {
    attempts: {
      getAttempt: async (id) => attempts.get(id) ?? null,
      updateAttempt: async (id, patch) => {
        const attempt = attempts.get(id);
        if (!attempt) {
          throw new Error("attempt not found");
        }
        Object.assign(attempt, patch);
        return attempt;
      },
    },
    slots: {
      reserveSlot: async (attempt) => {
        reserved.push(attempt.id);
        return { reservationId: `slot-${reserved.length}` };
      },
      releaseSlot: async (attempt) => {
        released.push(attempt.id);
      },
      commitSlot: async (attempt) => {
        committed.push(attempt.id);
      },
    },
    flowProvider: {
      getSteps: async (phase) => stepsByPhase.get(phase) ?? [],
    },
    stepExecutor: {
      execute: async (step: FlowStep) => ({
        stepId: step.id,
        status: "SUCCEEDED",
        output: { state: {}, public: {} },
        logs: [],
      }),
    } as never,
    ledgerPoster: options.ledger
      ? {
        postPaymentConfirmation: async () => options.ledger!,
        postScenario: async () => options.ledger!,
      }
      : undefined,
  };

  return {
    engine: new DynamicRailEngine(engineOptions),
    attempts,
    reserved,
    released,
    committed,
    stepsByPhase,
  };
};

describe("attempt state machine transitions", () => {
  test("allows the documented forward-only transitions", async () => {
    const harness = createHarness();
    const attempt = createAttempt();
    harness.attempts.set(attempt.id, attempt);
    await harness.engine.transition(attempt, "INITIATING");
    await harness.engine.transition(attempt, "AWAITING_CUSTOMER");
    await harness.engine.transition(attempt, "AUTHORIZING");
    await harness.engine.transition(attempt, "VERIFYING");
    await harness.engine.transition(attempt, "SUCCEEDED");
    expect(attempt.status).toBe("SUCCEEDED");
  });

  test("refuses to downgrade a SUCCEEDED attempt", async () => {
    const harness = createHarness();
    const attempt = createAttempt({ status: "SUCCEEDED" });
    harness.attempts.set(attempt.id, attempt);
    await expect(harness.engine.transition(attempt, "FAILED")).rejects.toThrow();
    await expect(harness.engine.transition(attempt, "UNKNOWN")).rejects.toThrow();
  });

  test("allows a late success recovery from FAILED and EXPIRED", async () => {
    const harness = createHarness();
    const failed = createAttempt({ status: "FAILED" });
    harness.attempts.set(failed.id, failed);
    await harness.engine.transition(failed, "SUCCEEDED");
    expect(failed.status).toBe("SUCCEEDED");
    const expired = createAttempt({ status: "EXPIRED" });
    harness.attempts.set(expired.id, expired);
    await harness.engine.transition(expired, "SUCCEEDED");
    expect(expired.status).toBe("SUCCEEDED");
  });

  test("refuses an illegal transition", async () => {
    const harness = createHarness();
    const attempt = createAttempt({ status: "CREATED" });
    harness.attempts.set(attempt.id, attempt);
    await expect(harness.engine.transition(attempt, "SUCCEEDED")).rejects.toThrow();
  });

  test("holds the slot reservation through UNKNOWN", async () => {
    const harness = createHarness();
    const attempt = createAttempt({ status: "AUTHORIZING" });
    harness.attempts.set(attempt.id, attempt);
    await harness.engine.transition(attempt, "UNKNOWN");
    expect(attempt.status).toBe("UNKNOWN");
    expect(harness.released).toEqual([]);
    expect(harness.committed).toEqual([]);
  });
});

describe("slot reservation on initiate", () => {
  test("reserves a slot before running the initiate flow", async () => {
    const harness = createHarness();
    const attempt = createAttempt();
    harness.attempts.set(attempt.id, attempt);
    const result = await harness.engine.initiate(attempt, { phone: "0912345678" });
    expect(harness.reserved).toEqual(["attempt-1"]);
    expect(result.status).toBe("AWAITING_CUSTOMER");
    expect(attempt.status).toBe("AWAITING_CUSTOMER");
  });

  test("releases the slot when the initiate flow fails", async () => {
    const harness = createHarness();
    harness.stepsByPhase.set("INITIATE", [
      { id: "step-1", type: "HTTP", side_effect: "MOVES_MONEY" },
    ]);
    const attempt = createAttempt();
    harness.attempts.set(attempt.id, attempt);
    const failingExecutor = {
      execute: async () => ({
        stepId: "step-1",
        status: "FAILED" as const,
        output: { state: {}, public: {} },
        logs: [],
      }),
    };
    const engine = new DynamicRailEngine({
      ...(harness.engine as never as { options: DynamicRailEngineOptions }).options,
      stepExecutor: failingExecutor as never,
    });
    const result = await engine.initiate(attempt, {});
    expect(result.status).toBe("FAILED");
    expect(harness.released).toEqual(["attempt-1"]);
  });
});

describe("OTP retry limits", () => {
  test("a retryable OTP keeps the attempt awaiting the customer", async () => {
    const harness = createHarness();
    const attempt = createAttempt({ status: "AWAITING_CUSTOMER" });
    harness.attempts.set(attempt.id, attempt);
    const otpExecutor = {
      execute: async () => ({
        stepId: "step-1",
        status: "AWAITING_CUSTOMER" as const,
        canonicalError: "RETRYABLE_OTP",
        output: { state: {}, public: {} },
        logs: [],
      }),
    };
    const engine = new DynamicRailEngine({
      ...(harness.engine as never as { options: DynamicRailEngineOptions }).options,
      stepExecutor: otpExecutor as never,
    });
    const result = await engine.confirm(attempt, { otp: "0000" });
    expect(result.status).toBe("AWAITING_CUSTOMER");
    expect(result.canonicalError).toBe("RETRYABLE_OTP");
    expect(attempt.otpAttempts).toBe(1);
    expect(attempt.status).toBe("AWAITING_CUSTOMER");
  });

  test("the third failed OTP attempt transitions the attempt to FAILED", async () => {
    const harness = createHarness();
    const attempt = createAttempt({ status: "AWAITING_CUSTOMER", otpAttempts: 2 });
    harness.attempts.set(attempt.id, attempt);
    const otpExecutor = {
      execute: async () => ({
        stepId: "step-1",
        status: "AWAITING_CUSTOMER" as const,
        canonicalError: "RETRYABLE_OTP",
        output: { state: {}, public: {} },
        logs: [],
      }),
    };
    const engine = new DynamicRailEngine({
      ...(harness.engine as never as { options: DynamicRailEngineOptions }).options,
      stepExecutor: otpExecutor as never,
    });
    const result = await engine.confirm(attempt, { otp: "0000" });
    expect(result.status).toBe("FAILED");
    expect(attempt.otpAttempts).toBe(3);
    expect(attempt.status).toBe("FAILED");
    expect(harness.released).toEqual(["attempt-1"]);
  });
});

describe("trusted success facts", () => {
  const attempt = createAttempt({
    gatewayReference: "GW-1",
    env: "LIVE",
    currency: "LYD",
    totalChargedAmount: "100.0000",
    platformCommissionAmount: "3.0000",
    netMerchantAmount: "97.0000",
  });

  test("accepts evidence that satisfies all five facts", () => {
    const engine = createHarness().engine;
    const result = engine.verifyTrustedSuccessFacts(
      {
        status: "PAID",
        reference: "GW-1",
        amount: "100.0000",
        currency: "LYD",
        environment: "LIVE",
      },
      attempt,
    );
    expect(result.trusted).toBe(true);
    expect(Object.values(result.facts).every(Boolean)).toBe(true);
  });

  test("fails when the amount does not match", () => {
    const engine = createHarness().engine;
    const result = engine.verifyTrustedSuccessFacts(
      {
        status: "PAID",
        reference: "GW-1",
        amount: "99.0000",
        currency: "LYD",
        environment: "LIVE",
      },
      attempt,
    );
    expect(result.trusted).toBe(false);
    expect(result.facts.amount).toBe(false);
  });

  test("fails on a cross environment callback", () => {
    const engine = createHarness().engine;
    const result = engine.verifyTrustedSuccessFacts(
      {
        status: "PAID",
        reference: "GW-1",
        amount: "100.0000",
        currency: "LYD",
        environment: "SANDBOX",
      },
      attempt,
    );
    expect(result.trusted).toBe(false);
    expect(result.facts.environment).toBe(false);
  });

  test("fails when the reference does not match", () => {
    const engine = createHarness().engine;
    const result = engine.verifyTrustedSuccessFacts(
      {
        status: "PAID",
        reference: "GW-OTHER",
        amount: "100.0000",
        currency: "LYD",
        environment: "LIVE",
      },
      attempt,
    );
    expect(result.trusted).toBe(false);
    expect(result.facts.reference).toBe(false);
  });
});

describe("point of no return", () => {
  test("an UNKNOWN money attempt cannot be resubmitted", async () => {
    const harness = createHarness();
    const attempt = createAttempt({ status: "UNKNOWN", pointOfNoReturn: true });
    harness.attempts.set(attempt.id, attempt);
    await expect(harness.engine.confirm(attempt, { otp: "1234" })).rejects.toThrow();
  });

  test("confirm marks the attempt as point of no return", async () => {
    const harness = createHarness();
    const attempt = createAttempt({ status: "AWAITING_CUSTOMER" });
    harness.attempts.set(attempt.id, attempt);
    const executor = {
      execute: async () => ({
        stepId: "step-1",
        status: "UNKNOWN" as const,
        output: { state: {}, public: {} },
        logs: [],
      }),
    };
    const engine = new DynamicRailEngine({
      ...(harness.engine as never as { options: DynamicRailEngineOptions }).options,
      stepExecutor: executor as never,
    });
    const result = await engine.confirm(attempt, { otp: "1234" });
    expect(result.status).toBe("UNKNOWN");
    expect(attempt.pointOfNoReturn).toBe(true);
    expect(harness.released).toEqual([]);
  });
});

describe("ledger posting on success", () => {
  test("posts the ledger entry and commits the slot", async () => {
    const harness = createHarness({ ledger: { entry: { id: "journal-1" } } });
    const attempt = createAttempt({ status: "AWAITING_CUSTOMER" });
    harness.attempts.set(attempt.id, attempt);
    const executor = {
      execute: async () => ({
        stepId: "step-1",
        status: "SUCCEEDED" as const,
        response: {
          status: "SUCCESS",
          reference: "GW-1",
          amount: "100.0000",
          currency: "LYD",
          environment: "SANDBOX",
        },
        output: { state: {}, public: {} },
        logs: [],
      }),
    };
    const engine = new DynamicRailEngine({
      ...(harness.engine as never as { options: DynamicRailEngineOptions }).options,
      stepExecutor: executor as never,
    });
    const result = await engine.confirm(attempt, { otp: "1234" });
    expect(result.status).toBe("SUCCEEDED");
    expect(attempt.status).toBe("SUCCEEDED");
    expect(attempt.ledgerEntryId).toBe("journal-1");
    expect(harness.committed).toEqual(["attempt-1"]);
  });

  test("a failed trusted success check moves the attempt to UNKNOWN without posting", async () => {
    const harness = createHarness({ ledger: { entry: { id: "journal-1" } } });
    const attempt = createAttempt({ status: "AWAITING_CUSTOMER" });
    harness.attempts.set(attempt.id, attempt);
    const executor = {
      execute: async () => ({
        stepId: "step-1",
        status: "SUCCEEDED" as const,
        response: { status: "SUCCESS" },
        output: { state: {}, public: {} },
        logs: [],
      }),
    };
    const engine = new DynamicRailEngine({
      ...(harness.engine as never as { options: DynamicRailEngineOptions }).options,
      stepExecutor: executor as never,
    });
    const result = await engine.confirm(attempt, { otp: "1234" });
    expect(result.status).toBe("UNKNOWN");
    expect(attempt.ledgerEntryId).toBeUndefined();
    expect(harness.committed).toEqual([]);
  });
});
