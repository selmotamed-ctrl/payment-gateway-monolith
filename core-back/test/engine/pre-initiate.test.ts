import { describe, expect, test } from "bun:test";
import {
  DynamicRailEngine,
  type DynamicAttempt,
  type DynamicRailEngineOptions,
} from "../../engine/flow/DynamicRailEngine";
import type { FlowStep } from "../../engine/flow/StepExecutor";

const PRE_STEP: FlowStep = { id: "pre-initiate", type: "HTTP", side_effect: "READ_ONLY" };
const INITIATE_STEP: FlowStep = { id: "initiate", type: "HTTP", side_effect: "READ_ONLY" };

const attemptRow = (overrides: Partial<DynamicAttempt> = {}): DynamicAttempt => ({
  id: "attempt-1",
  reference: "PA-1",
  status: "CREATED",
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
  ...overrides,
});

const createHarness = (options: {
  preInitiate?: boolean;
  executor: (step: FlowStep) => { status: string; canonicalError?: string; output: { state: Record<string, unknown>; public: Record<string, unknown> } };
}) => {
  const attempt = attemptRow();
  const attempts = new Map<string, DynamicAttempt>([[attempt.id, attempt]]);
  const reserved: string[] = [];
  const released: string[] = [];
  const phases: string[] = [];
  const executed: string[] = [];
  const stepsByPhase = new Map<string, FlowStep[]>([["INITIATE", [INITIATE_STEP]]]);
  if (options.preInitiate) {
    stepsByPhase.set("PRE_INITIATE", [PRE_STEP]);
  }
  const engineOptions: DynamicRailEngineOptions = {
    attempts: {
      getAttempt: async (id) => attempts.get(id) ?? null,
      updateAttempt: async (id, patch) => {
        const target = attempts.get(id);
        if (!target) {
          throw new Error("attempt not found");
        }
        Object.assign(target, patch);
        return target;
      },
    },
    slots: {
      reserveSlot: async (target) => {
        reserved.push(target.id);
        return { reservationId: `slot-${target.id}` };
      },
      releaseSlot: async (target) => {
        released.push(target.id);
      },
      commitSlot: async () => ({ outcome: "COMMITTED" }),
    },
    flowProvider: {
      getSteps: async (phase) => {
        phases.push(phase);
        return stepsByPhase.get(phase) ?? [];
      },
    },
    stepExecutor: {
      execute: async (step: FlowStep) => {
        executed.push(step.id);
        return options.executor(step);
      },
    } as never,
  };
  return {
    engine: new DynamicRailEngine(engineOptions),
    attempt,
    reserved,
    released,
    phases,
    executed,
  };
};

const success = () => ({
  status: "AWAITING_CUSTOMER",
  output: { state: {}, public: {} },
});

describe("PRE_INITIATE execution", () => {
  test("a failed PRE_INITIATE aborts before any slot is reserved", async () => {
    const harness = createHarness({
      preInitiate: true,
      executor: (step) => step.id === PRE_STEP.id
        ? { status: "FAILED", canonicalError: "INELIGIBLE", output: { state: {}, public: {} } }
        : success(),
    });

    const result = await harness.engine.initiate(harness.attempt, { subscriber: "123" });

    expect(result.status).toBe("FAILED");
    expect(result.canonicalError).toBe("INELIGIBLE");
    expect(harness.attempt.status).toBe("FAILED");
    expect(harness.reserved).toEqual([]);
    expect(harness.executed).toEqual([PRE_STEP.id]);
  });

  test("a blocked PRE_INITIATE aborts before any slot is reserved", async () => {
    const harness = createHarness({
      preInitiate: true,
      executor: (step) => step.id === PRE_STEP.id
        ? { status: "BLOCKED", canonicalError: "SUBSCRIBER_BLOCKED", output: { state: {}, public: {} } }
        : success(),
    });

    const result = await harness.engine.initiate(harness.attempt, {});

    expect(result.status).toBe("BLOCKED");
    expect(harness.attempt.status).toBe("BLOCKED");
    expect(harness.reserved).toEqual([]);
    expect(harness.executed).toEqual([PRE_STEP.id]);
  });

  test("a successful PRE_INITIATE lets the initiation continue", async () => {
    const harness = createHarness({ preInitiate: true, executor: () => success() });

    const result = await harness.engine.initiate(harness.attempt, {});

    expect(result.status).toBe("AWAITING_CUSTOMER");
    expect(harness.reserved).toEqual(["attempt-1"]);
    expect(harness.executed).toEqual([PRE_STEP.id, INITIATE_STEP.id]);
    expect(harness.attempt.status).toBe("AWAITING_CUSTOMER");
  });

  test("a gateway without a PRE_INITIATE flow keeps the existing initiation", async () => {
    const harness = createHarness({ executor: () => success() });

    const result = await harness.engine.initiate(harness.attempt, {});

    expect(result.status).toBe("AWAITING_CUSTOMER");
    expect(harness.reserved).toEqual(["attempt-1"]);
    expect(harness.executed).toEqual([INITIATE_STEP.id]);
    expect(harness.attempt.status).toBe("AWAITING_CUSTOMER");
  });
});
