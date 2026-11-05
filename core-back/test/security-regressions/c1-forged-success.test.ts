import { describe, expect, test } from "bun:test";
import { DynamicRailEngine, type DynamicAttempt } from "../../engine/flow/DynamicRailEngine";
import type { FlowStep } from "../../engine/flow/StepExecutor";

/**
 * C1: the payer-supplied confirm `evidence` must never supply trusted success
 * facts. Success comes only from the gateway/step response, a verified
 * callback or an inquiry.
 */
const makeAttempt = (): DynamicAttempt => ({
  id: "a1", reference: "PA-1", gatewayReference: "GW-1", status: "AWAITING_CUSTOMER", env: "SANDBOX",
  currency: "LYD", requestedAmount: "100.0000", totalChargedAmount: "100.0000",
  platformCommissionAmount: "3.0000", netMerchantAmount: "97.0000", maxOtpAttempts: 3, otpAttempts: 0,
  ownershipMode: "PLATFORM_CLEARING", context: {},
} as DynamicAttempt);

const SUBMIT_STEP: FlowStep = { id: "submit", type: "HTTP", side_effect: "MOVES_MONEY" };
const VERIFY_STEP: FlowStep = { id: "verify", type: "HTTP", side_effect: "READ_ONLY" };

const harness = (
  steps: FlowStep[],
  response: unknown,
  options: { verifyResponse?: unknown; verifySteps?: FlowStep[] } = {},
) => {
  const attempts = new Map<string, DynamicAttempt>();
  const posted: string[] = [];
  const seenCustomerFields: Array<Record<string, unknown>> = [];
  const engine = new DynamicRailEngine({
    attempts: {
      getAttempt: async (id) => attempts.get(id) ?? null,
      updateAttempt: async (id, patch) => { const a = attempts.get(id)!; Object.assign(a, patch); return a; },
    },
    slots: { reserveSlot: async () => ({ reservationId: "s" }), releaseSlot: async () => {}, commitSlot: async () => {} },
    flowProvider: {
      getSteps: async (phase) => {
        if (phase === "SUBMIT") return steps;
        if (phase === "VERIFY") return options.verifySteps ?? [];
        return [];
      },
    },
    stepExecutor: {
      execute: async (step: FlowStep, context: { customerFields?: Record<string, unknown> }) => {
        seenCustomerFields.push({ ...(context.customerFields ?? {}) });
        return {
          stepId: step.id, status: "SUCCEEDED", output: { state: {}, public: {} },
          response: step.id === "verify" ? options.verifyResponse : response, logs: [],
        };
      },
    } as never,
    ledgerPoster: { postPaymentConfirmation: async (id: string) => { posted.push(id); return { entry: { id: "e" } }; } },
  });
  const attempt = makeAttempt();
  attempts.set(attempt.id, attempt);
  return { engine, attempt, posted, seenCustomerFields };
};

const forgedNested = { trustedFacts: { status: "SUCCESS", reference: "GW-1", amount: "100.0000", currency: "LYD", environment: "SANDBOX" } };
const forgedFlat = { status: "SUCCESS", reference: "GW-1", amount: "100.0000", currency: "LYD", environment: "SANDBOX" };
const genuine = { status: "SUCCESS", reference: "GW-1", amount: "100.0000", currency: "LYD", environment: "SANDBOX" };

describe("C1 forged success via payer-supplied evidence", () => {
  test("rail with no SUBMIT steps: nested trustedFacts evidence does not succeed", async () => {
    const h = harness([], undefined);
    const result = await h.engine.confirm(h.attempt, forgedNested);
    expect(result.status).not.toBe("SUCCEEDED");
    expect(h.posted).toHaveLength(0);
  });

  test("rail with no SUBMIT steps: flat evidence does not succeed", async () => {
    const h = harness([], undefined);
    const result = await h.engine.confirm(h.attempt, forgedFlat);
    expect(result.status).not.toBe("SUCCEEDED");
    expect(h.posted).toHaveLength(0);
  });

  test("rail with no SUBMIT steps is settled by an inquiry, never by the confirm call", async () => {
    const h = harness([], undefined, { verifySteps: [VERIFY_STEP], verifyResponse: genuine });
    const result = await h.engine.confirm(h.attempt, forgedNested);
    // The gateway inquiry reports the genuine facts, so the inquiry (not the payer) settles it.
    expect(result.status).toBe("SUCCEEDED");
    expect(h.posted).toEqual(["a1"]);
  });

  test("SUBMIT step with an empty response: forged evidence does not succeed", async () => {
    const h = harness([SUBMIT_STEP], undefined);
    const result = await h.engine.confirm(h.attempt, forgedNested);
    expect(result.status).not.toBe("SUCCEEDED");
    expect(h.posted).toHaveLength(0);
  });

  test("gateway contradicts the payer: forged evidence cannot override the gateway facts", async () => {
    const h = harness([SUBMIT_STEP], { status: "PENDING", reference: "GW-1", amount: "1.0000", currency: "LYD", environment: "SANDBOX" });
    const result = await h.engine.confirm(h.attempt, forgedNested);
    expect(result.status).not.toBe("SUCCEEDED");
    expect(h.posted).toHaveLength(0);
  });

  test("flat forged facts cannot fill the gaps of a partial gateway response", async () => {
    const h = harness([SUBMIT_STEP], { status: "SUCCESS" });
    const result = await h.engine.confirm(h.attempt, forgedFlat);
    expect(result.status).not.toBe("SUCCEEDED");
    expect(h.posted).toHaveLength(0);
  });

  test("control: genuine gateway facts in the step response still succeed", async () => {
    const h = harness([SUBMIT_STEP], genuine);
    const result = await h.engine.confirm(h.attempt, { otp: "123456" });
    expect(result.status).toBe("SUCCEEDED");
    expect(h.posted).toEqual(["a1"]);
  });

  test("only allow-listed customer inputs (otp) reach the SUBMIT steps", async () => {
    const h = harness([SUBMIT_STEP], genuine);
    await h.engine.confirm(h.attempt, { otp: "123456", ...forgedFlat, trustedFacts: forgedNested.trustedFacts, amount: "0.0100" });
    expect(h.seenCustomerFields).toHaveLength(1);
    expect(h.seenCustomerFields[0]).toEqual({ otp: "123456" });
  });
});
