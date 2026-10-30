/**
 * Suite 04.1 — 20 gateways × 24 deterministic lifecycle scenarios.
 *
 * Every cell drives the real `DynamicRailEngine`. The gateway dimension pins
 * the reference format of the attempt, so all 480 cells execute a distinct
 * end-to-end lifecycle rather than a repeated assertion.
 */
import { describe, expect, test } from "bun:test";
import {
  ALL_GATEWAY_CODES,
  errorCode,
} from "../_harness";
import {
  awaitingOtpStep,
  createHarness,
  failedStep,
  successStep,
  trustedResponse,
  unknownStep,
  type EngineHarness,
} from "./_engineHarness";
import type { CallbackVerifier } from "../../../engine/flow/DynamicRailEngine";

type Scenario = {
  id: string;
  title: string;
  run: (gateway: string) => Promise<void>;
};

const initiate = async (harness: EngineHarness) => {
  return harness.engine.initiate(harness.attempt, { phone: "0912345678" });
};

const verifiedCallback = (evidence: Record<string, unknown>): CallbackVerifier => ({
  async verify(_channel, rawRequest) {
    const request = rawRequest as Record<string, unknown>;
    return {
      verified: true,
      attemptId: String(request.attemptId),
      evidence,
    };
  },
});

const SCENARIOS: readonly Scenario[] = [
  {
    id: "S01",
    title: "happy path end-to-end",
    async run(gateway) {
      const h = createHarness(gateway);
      await initiate(h);
      const result = await h.engine.confirm(h.attempt, { otp: "123456" });
      expect(result.status).toBe("SUCCEEDED");
      expect(h.calls.reserve).toHaveLength(1);
      expect(h.calls.commit).toHaveLength(1);
      expect(h.calls.ledgerConfirmation).toHaveLength(1);
      expect(h.attempt.status).toBe("SUCCEEDED");
    },
  },
  {
    id: "S02",
    title: "mistyped OTP on the first attempt then success",
    async run(gateway) {
      const h = createHarness(gateway, {
        scripts: {
          SUBMIT: [awaitingOtpStep(), successStep(trustedResponse(createHarness(gateway).attempt))],
        },
      });
      // Rebuild the successful response against this attempt's reference.
      h.scripts.SUBMIT = [
        awaitingOtpStep(),
        successStep({
          status: "SUCCESS",
          reference: h.attempt.gatewayReference,
          amount: h.attempt.totalChargedAmount,
          currency: h.attempt.currency,
          environment: h.attempt.env,
        }),
      ];
      await initiate(h);
      const first = await h.engine.confirm(h.attempt, { otp: "000000" });
      expect(first.status).toBe("AWAITING_CUSTOMER");
      expect(h.attempt.otpAttempts).toBe(1);
      const second = await h.engine.confirm(h.attempt, { otp: "123456" });
      expect(second.status).toBe("SUCCEEDED");
    },
  },
  {
    id: "S03",
    title: "three consecutive wrong OTPs lock the attempt",
    async run(gateway) {
      const h = createHarness(gateway, {
        scripts: { SUBMIT: [awaitingOtpStep(), awaitingOtpStep(), awaitingOtpStep()] },
      });
      await initiate(h);
      await h.engine.confirm(h.attempt, { otp: "1" });
      await h.engine.confirm(h.attempt, { otp: "2" });
      const third = await h.engine.confirm(h.attempt, { otp: "3" });
      expect(third.status).toBe("FAILED");
      expect(h.attempt.otpAttempts).toBe(3);
      expect(h.calls.release).toHaveLength(1);
    },
  },
  {
    id: "S04",
    title: "OTP retry before cooldown stays awaiting and counts",
    async run(gateway) {
      const h = createHarness(gateway, {
        scripts: { SUBMIT: [awaitingOtpStep(), awaitingOtpStep()] },
      });
      await initiate(h);
      const first = await h.engine.confirm(h.attempt, { otp: "1" });
      const second = await h.engine.confirm(h.attempt, { otp: "2" });
      expect(first.status).toBe("AWAITING_CUSTOMER");
      expect(second.status).toBe("AWAITING_CUSTOMER");
      expect(h.attempt.otpAttempts).toBe(2);
    },
  },
  {
    id: "S05",
    title: "insufficient funds is a terminal decline",
    async run(gateway) {
      const h = createHarness(gateway, { scripts: { SUBMIT: failedStep("INSUFFICIENT_FUNDS") } });
      await initiate(h);
      const result = await h.engine.confirm(h.attempt, { otp: "123456" });
      expect(result.status).toBe("FAILED");
      expect(h.calls.release).toHaveLength(1);
      expect(h.calls.commit).toHaveLength(0);
    },
  },
  {
    id: "S06",
    title: "customer limit exceeded is a terminal decline",
    async run(gateway) {
      const h = createHarness(gateway, { scripts: { SUBMIT: failedStep("LIMIT_EXCEEDED") } });
      await initiate(h);
      const result = await h.engine.confirm(h.attempt, { otp: "123456" });
      expect(result.status).toBe("FAILED");
      expect(h.calls.release).toHaveLength(1);
    },
  },
  {
    id: "S07",
    title: "cancel before the point of no return is allowed",
    async run(gateway) {
      const h = createHarness(gateway);
      await initiate(h);
      await h.engine.transition(h.attempt, "CANCELLED");
      expect(h.attempt.status).toBe("CANCELLED");
    },
  },
  {
    id: "S08",
    title: "cancel after the point of no return is refused",
    async run(gateway) {
      const h = createHarness(gateway, { scripts: { SUBMIT: unknownStep() } });
      await initiate(h);
      await h.engine.confirm(h.attempt, { otp: "123456" });
      expect(h.attempt.status).toBe("UNKNOWN");
      await expect(h.engine.transition(h.attempt, "CANCELLED")).rejects.toThrow();
    },
  },
  {
    id: "S09",
    title: "gateway 5xx during INITIATE parks the attempt in UNKNOWN",
    async run(gateway) {
      const h = createHarness(gateway, { scripts: { INITIATE: unknownStep("HTTP_500", "INITIATE") } });
      const result = await initiate(h);
      expect(result.status).toBe("UNKNOWN");
      expect(h.attempt.status).toBe("UNKNOWN");
      expect(h.calls.reserve).toHaveLength(1);
      expect(h.calls.release).toHaveLength(0);
    },
  },
  {
    id: "S10",
    title: "timeout during SUBMIT becomes UNKNOWN and holds the slot",
    async run(gateway) {
      const h = createHarness(gateway, { scripts: { SUBMIT: unknownStep("GATEWAY_TIMEOUT") } });
      await initiate(h);
      const result = await h.engine.confirm(h.attempt, { otp: "123456" });
      expect(result.status).toBe("UNKNOWN");
      expect(h.calls.release).toHaveLength(0);
      expect(h.calls.commit).toHaveLength(0);
    },
  },
  {
    id: "S11",
    title: "TCP reset during SUBMIT becomes UNKNOWN",
    async run(gateway) {
      const h = createHarness(gateway, { scripts: { SUBMIT: unknownStep("TCP_RESET") } });
      await initiate(h);
      expect((await h.engine.confirm(h.attempt, { otp: "1" })).status).toBe("UNKNOWN");
      expect(h.calls.release).toHaveLength(0);
    },
  },
  {
    id: "S12",
    title: "HTTP 502 during SUBMIT becomes UNKNOWN",
    async run(gateway) {
      const h = createHarness(gateway, { scripts: { SUBMIT: unknownStep("HTTP_502") } });
      await initiate(h);
      expect((await h.engine.confirm(h.attempt, { otp: "1" })).status).toBe("UNKNOWN");
      expect(h.calls.release).toHaveLength(0);
    },
  },
  {
    id: "S13",
    title: "malformed successful response becomes UNKNOWN",
    async run(gateway) {
      const h = createHarness(gateway, { scripts: { SUBMIT: unknownStep("MALFORMED_RESPONSE") } });
      await initiate(h);
      const result = await h.engine.confirm(h.attempt, { otp: "1" });
      expect(result.canonicalError).toBe("MALFORMED_RESPONSE");
      expect(result.status).toBe("UNKNOWN");
    },
  },
  {
    id: "S14",
    title: "inquiry recovers an UNKNOWN attempt to SUCCEEDED",
    async run(gateway) {
      const h = createHarness(gateway, {
        scripts: {
          VERIFY: successStep({
            status: "SUCCESS",
            reference: "",
            amount: "100.0000",
            currency: "LYD",
            environment: "SANDBOX",
          }, "VERIFY"),
        },
      });
      h.scripts.VERIFY = [successStep({
        status: "SUCCESS",
        reference: h.attempt.gatewayReference,
        amount: h.attempt.totalChargedAmount,
        currency: h.attempt.currency,
        environment: h.attempt.env,
      }, "VERIFY")];
      h.attempt.status = "UNKNOWN";
      h.attempt.pointOfNoReturn = true;
      const result = await h.engine.inquire(h.attempt);
      expect(result.status).toBe("SUCCEEDED");
      expect(h.calls.ledgerConfirmation).toHaveLength(1);
      expect(h.calls.commit).toHaveLength(1);
    },
  },
  {
    id: "S15",
    title: "inquiry resolves an UNKNOWN attempt to FAILED and releases the slot",
    async run(gateway) {
      const h = createHarness(gateway, { scripts: { VERIFY: failedStep("NEVER_DEBITED", "VERIFY") } });
      h.attempt.status = "UNKNOWN";
      h.attempt.pointOfNoReturn = true;
      const result = await h.engine.inquire(h.attempt);
      expect(result.status).toBe("FAILED");
      expect(h.calls.release).toHaveLength(1);
      expect(h.calls.ledgerConfirmation).toHaveLength(0);
    },
  },
  {
    id: "S16",
    title: "duplicate webhook posts the ledger exactly once",
    async run(gateway) {
      let harness: EngineHarness;
      const verifier: CallbackVerifier = {
        async verify() {
          return {
            verified: true,
            attemptId: harness.attempt.id,
            evidence: {
              status: "SUCCESS",
              reference: harness.attempt.gatewayReference,
              amount: harness.attempt.totalChargedAmount,
              currency: harness.attempt.currency,
              environment: harness.attempt.env,
            },
          };
        },
      };
      harness = createHarness(gateway, { callbackVerifier: verifier });
      harness.attempt.status = "AWAITING_CUSTOMER";
      const raw = { attemptId: harness.attempt.id, dedupeKey: "evt-shared" };
      await harness.engine.verifyCallback("WEBHOOK", raw);
      await harness.engine.verifyCallback("WEBHOOK", raw);
      expect(harness.calls.ledgerConfirmation).toHaveLength(1);
      expect(harness.calls.commit).toHaveLength(1);
    },
  },
  {
    id: "S17",
    title: "out-of-order late failure cannot downgrade SUCCEEDED",
    async run(gateway) {
      let harness: EngineHarness;
      let mode: "success" | "failure" = "success";
      const verifier: CallbackVerifier = {
        async verify() {
          return {
            verified: true,
            attemptId: harness.attempt.id,
            evidence: {
              status: mode === "success" ? "SUCCESS" : "FAILED",
              reference: harness.attempt.gatewayReference,
              amount: harness.attempt.totalChargedAmount,
              currency: harness.attempt.currency,
              environment: harness.attempt.env,
            },
          };
        },
      };
      harness = createHarness(gateway, { callbackVerifier: verifier });
      harness.attempt.status = "AWAITING_CUSTOMER";
      await harness.engine.verifyCallback("WEBHOOK", { attemptId: harness.attempt.id, dedupeKey: "evt-1" });
      expect(String(harness.attempt.status)).toBe("SUCCEEDED");
      mode = "failure";
      await expect(
        harness.engine.verifyCallback("WEBHOOK", { attemptId: harness.attempt.id, dedupeKey: "evt-2" }),
      ).rejects.toThrow();
      expect(String(harness.attempt.status)).toBe("SUCCEEDED");
      expect(harness.calls.ledgerConfirmation).toHaveLength(1);
    },
  },
  {
    id: "S18",
    title: "conflicting trusted signals open a P1 CONFLICT case",
    async run(gateway) {
      const h = createHarness(gateway, { scripts: { VERIFY: failedStep("GATEWAY_FAILED", "VERIFY") } });
      h.attempt.status = "UNKNOWN";
      h.attempt.context = { trustedSuccessObserved: true };
      const result = await h.engine.inquire(h.attempt);
      expect(result.status).toBe("UNKNOWN");
      expect(result.canonicalError).toBe("CONFLICTING_TRUSTED_SIGNALS");
      expect(h.calls.operatorCases[0]?.kind).toBe("CONFLICT");
      expect(h.calls.operatorCases[0]?.priority).toBe("P1");
    },
  },
  {
    id: "S19",
    title: "forged webhook signature is refused",
    async run(gateway) {
      const h = createHarness(gateway, {
        callbackVerifier: {
          async verify() {
            return { verified: false, reason: "bad signature" };
          },
        },
      });
      const failure = await h.engine.verifyCallback("WEBHOOK", { attemptId: h.attempt.id }).catch((error) => error);
      expect(errorCode(failure)).toBe("CALLBACK_VERIFICATION_FAILED");
    },
  },
  {
    id: "S20",
    title: "cross-environment webhook is refused",
    async run(gateway) {
      const fresh = createHarness(gateway, {
        callbackVerifier: {
          async verify() {
            return {
              verified: true,
              attemptId: fresh.attempt.id,
              evidence: {
                status: "SUCCESS",
                reference: fresh.attempt.gatewayReference,
                amount: fresh.attempt.totalChargedAmount,
                currency: fresh.attempt.currency,
                environment: "LIVE",
              },
            };
          },
        },
      });
      fresh.attempt.status = "AWAITING_CUSTOMER";
      const failure = await fresh.engine
        .verifyCallback("WEBHOOK", { attemptId: fresh.attempt.id })
        .catch((error) => error);
      expect(errorCode(failure)).toBe("CALLBACK_ENVIRONMENT_MISMATCH");
      expect(fresh.calls.ledgerConfirmation).toHaveLength(0);
    },
  },
  {
    id: "S21a",
    title: "late success after EXPIRED recovers and opens a LATE_SUCCESS case",
    async run(gateway) {
      const h = createHarness(gateway, {
        scripts: {
          VERIFY: successStep({
            status: "SUCCESS",
            reference: "",
            amount: "100.0000",
            currency: "LYD",
            environment: "SANDBOX",
          }, "VERIFY"),
        },
      });
      h.scripts.VERIFY = [successStep({
        status: "SUCCESS",
        reference: h.attempt.gatewayReference,
        amount: h.attempt.totalChargedAmount,
        currency: h.attempt.currency,
        environment: h.attempt.env,
      }, "VERIFY")];
      h.attempt.status = "EXPIRED";
      const result = await h.engine.inquire(h.attempt);
      expect(result.status).toBe("SUCCEEDED");
      expect(h.calls.operatorCases[0]?.kind).toBe("LATE_SUCCESS");
      expect(h.calls.operatorCases[0]?.priority).toBe("P2");
    },
  },
  {
    id: "S21b",
    title: "late success on an exhausted link routes to SUSPENSE",
    async run(gateway) {
      const h = createHarness(gateway, {
        commitResult: { outcome: "SUSPENSE", journalEntryId: "suspense-entry" },
      });
      h.scripts.VERIFY = [successStep({
        status: "SUCCESS",
        reference: h.attempt.gatewayReference,
        amount: h.attempt.totalChargedAmount,
        currency: h.attempt.currency,
        environment: h.attempt.env,
      }, "VERIFY")];
      h.attempt.status = "EXPIRED";
      const result = await h.engine.inquire(h.attempt);
      expect(result.status).toBe("SUCCEEDED");
      expect(result.settlement).toBe("SUSPENSE");
      expect(result.substatus).toBe("SUSPENSE_SETTLEMENT");
      expect(h.calls.operatorCases[0]?.kind).toBe("LATE_SUCCESS");
    },
  },
  {
    id: "S22a",
    title: "settled amount beyond tolerance parks the attempt in UNKNOWN",
    async run(gateway) {
      const h = createHarness(gateway);
      h.scripts.SUBMIT = [successStep({
        status: "SUCCESS",
        reference: h.attempt.gatewayReference,
        amount: "99.5000",
        currency: h.attempt.currency,
        environment: h.attempt.env,
      })];
      await initiate(h);
      const result = await h.engine.confirm(h.attempt, { otp: "1" });
      expect(result.status).toBe("UNKNOWN");
      expect(h.calls.ledgerConfirmation).toHaveLength(0);
    },
  },
  {
    id: "S22b",
    title: "a suspense slot decision is not reported as a clean success",
    async run(gateway) {
      const h = createHarness(gateway, {
        commitResult: { outcome: "SUSPENSE", journalEntryId: "suspense-entry" },
      });
      await initiate(h);
      const result = await h.engine.confirm(h.attempt, { otp: "1" });
      expect(result.status).toBe("SUCCEEDED");
      expect(result.settlement).toBe("SUSPENSE");
      expect(h.attempt.substatus).toBe("SUSPENSE_SETTLEMENT");
      expect(h.calls.ledgerConfirmation).toHaveLength(0);
    },
  },
  {
    id: "S23",
    title: "full and partial refunds plus an over-refund refusal",
    async run(gateway) {
      const full = createHarness(gateway);
      full.attempt.status = "SUCCEEDED";
      full.attempt.settledAmount = "100.0000";
      full.scripts.REFUND = [successStep({ status: "SUCCESS" }, "REFUND")];
      const fullResult = await full.engine.refund(full.attempt, "100.0000", "adj-full");
      expect(fullResult.status).toBe("REFUNDED");
      expect(full.calls.ledgerScenario).toHaveLength(1);

      const partial = createHarness(gateway);
      partial.attempt.status = "SUCCEEDED";
      partial.attempt.settledAmount = "100.0000";
      partial.scripts.REFUND = [successStep({ status: "SUCCESS" }, "REFUND")];
      const partialResult = await partial.engine.refund(partial.attempt, "30.0000", "adj-partial");
      expect(partialResult.status).toBe("PARTIALLY_REFUNDED");
      const over = await partial.engine.refund(partial.attempt, "150.0000", "adj-over").catch((error) => error);
      expect(errorCode(over)).toBe("REFUND_AMOUNT_EXCEEDED");
    },
  },
  {
    id: "S24",
    title: "refund timeout stays EXECUTING and schedules reconciliation",
    async run(gateway) {
      const h = createHarness(gateway, {
        scripts: { REFUND: unknownStep("REFUND_TIMEOUT", "REFUND") },
      });
      h.attempt.status = "SUCCEEDED";
      h.attempt.settledAmount = "100.0000";
      const result = await h.engine.refund(h.attempt, "10.0000", "adj-unknown");
      expect(result.status).toBe("UNKNOWN");
      expect(h.attempt.adjustmentState).toBe("EXECUTING");
      expect(h.calls.scheduled).toHaveLength(1);
    },
  },
];

describe("Suite 04 · 20 gateways × 24 lifecycle scenarios", () => {
  test(`the Cartesian matrix expands to ${ALL_GATEWAY_CODES.length * SCENARIOS.length} flows`, () => {
    expect(SCENARIOS).toHaveLength(26);
    expect(ALL_GATEWAY_CODES.length * SCENARIOS.length).toBe(546);
  });

  for (const gateway of ALL_GATEWAY_CODES) {
    for (const scenario of SCENARIOS) {
      test(`${gateway} · ${scenario.id} ${scenario.title}`, async () => {
        await scenario.run(gateway);
      });
    }
  }
});
