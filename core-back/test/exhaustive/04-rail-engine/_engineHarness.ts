/**
 * A focused harness for the real `DynamicRailEngine`.
 *
 * The engine is production code; only its collaborators (the repository, the
 * slot store, the declarative flow and the step executor) are supplied by the
 * test so a single scenario can be driven deterministically. The HTTP/step
 * execution itself is covered directly in Suite 03 and by the live E2E suite.
 */
import { Decimal } from "decimal.js";
import {
  DynamicRailEngine,
  type AttemptRepository,
  type CallbackInbox,
  type CallbackVerificationResult,
  type CallbackVerifier,
  type DynamicAttempt,
  type DynamicAttemptPatch,
  type DynamicRailEngineOptions,
  type SlotCommitResult,
  type SlotReservationStore,
} from "../../../engine/flow/DynamicRailEngine";
import type {
  FlowStep,
  StepExecutionResult,
} from "../../../engine/flow/StepExecutor";
import type { OperatorCaseOpenInput } from "../../../engine/flow/DynamicRailEngine";

export type Phase = "PRE_INITIATE" | "INITIATE" | "SUBMIT" | "VERIFY" | "CANCEL" | "REFUND" | "VOID";

export const stepFor = (phase: Phase, overrides: Partial<FlowStep> = {}): FlowStep => ({
  id: `${phase}-${overrides.id ?? "1"}`,
  type: "HTTP",
  method: "POST",
  url_template: `https://gateway.example/${phase.toLowerCase()}`,
  side_effect: phase === "SUBMIT" || phase === "REFUND" ? "MOVES_MONEY" : "SENDS_NOTIFICATION",
  retry_policy: phase === "SUBMIT" || phase === "REFUND" ? "NEVER" : "SAFE",
  point_of_no_return: phase === "SUBMIT",
  ...overrides,
});

export interface ScriptedResult extends StepExecutionResult {
  output: StepExecutionResult["output"];
}

export const successStep = (
  response: Record<string, unknown>,
  phase: Phase = "SUBMIT",
): ScriptedResult => ({
  stepId: `${phase}-1`,
  status: "SUCCEEDED",
  response,
  output: { state: {}, public: {} },
  logs: [],
});

export const failedStep = (
  canonicalError: string,
  phase: Phase = "SUBMIT",
): ScriptedResult => ({
  stepId: `${phase}-1`,
  status: "FAILED",
  canonicalError,
  output: { state: {}, public: {} },
  logs: [],
});

export const unknownStep = (canonicalError = "GATEWAY_TIMEOUT", phase: Phase = "SUBMIT"): ScriptedResult => ({
  stepId: `${phase}-1`,
  status: "UNKNOWN",
  canonicalError,
  output: { state: {}, public: {} },
  logs: [],
});

export const awaitingOtpStep = (phase: Phase = "SUBMIT"): ScriptedResult => ({
  stepId: `${phase}-1`,
  status: "AWAITING_CUSTOMER",
  canonicalError: "RETRYABLE_OTP",
  output: { state: {}, public: {} },
  logs: [],
});

export interface EngineHarnessOptions {
  scripts?: Partial<Record<Phase, ScriptedResult | ScriptedResult[]>>;
  steps?: Partial<Record<Phase, FlowStep[]>>;
  commitResult?: SlotCommitResult;
  callbackVerifier?: CallbackVerifier;
}

export interface EngineHarness {
  engine: DynamicRailEngine;
  attempts: Map<string, DynamicAttempt>;
  calls: {
    reserve: string[];
    release: string[];
    commit: string[];
    ledgerConfirmation: string[];
    ledgerScenario: string[];
    operatorCases: OperatorCaseOpenInput[];
    scheduled: Array<{ attemptId: string; adjustmentId: string }>;
    inbox: string[];
  };
  scripts: Partial<Record<Phase, ScriptedResult[]>>;
  attempt: DynamicAttempt;
}

export const createAttemptFor = (
  gateway: string,
  overrides: Partial<DynamicAttempt> = {},
): DynamicAttempt => ({
  id: `attempt-${gateway}-${crypto.randomUUID().slice(0, 8)}`,
  reference: `PA-${gateway.toUpperCase()}-${crypto.randomUUID().slice(0, 8)}`,
  gatewayReference: `GW-${gateway.toUpperCase()}-REF`,
  status: "CREATED",
  mode: "OTP_PULL",
  env: "SANDBOX",
  currency: "LYD",
  requestedAmount: "100.0000",
  surchargeAmount: "0",
  totalChargedAmount: "100.0000",
  gatewayFeeAmount: "1.0000",
  platformCommissionAmount: "3.0000",
  netMerchantAmount: "97.0000",
  feeBearer: "MERCHANT_ABSORBS",
  ownershipMode: "PLATFORM_CLEARING",
  maxOtpAttempts: 3,
  otpAttempts: 0,
  mismatchTolerance: "0.0100",
  expiresAt: new Date(Date.now() + 600_000),
  context: {},
  ...overrides,
});

export const createHarness = (
  gateway: string,
  options: EngineHarnessOptions = {},
): EngineHarness => {
  const attempts = new Map<string, DynamicAttempt>();
  const attempt = createAttemptFor(gateway);
  attempts.set(attempt.id, attempt);

  const scripts: Partial<Record<Phase, ScriptedResult[]>> = {};
  for (const [phase, value] of Object.entries(options.scripts ?? {})) {
    scripts[phase as Phase] = Array.isArray(value) ? [...value] : [value];
  }
  // Default to a successful SUBMIT with a valid trusted response.
  if (!scripts.SUBMIT) {
    scripts.SUBMIT = [successStep({
      status: "SUCCESS",
      reference: attempt.gatewayReference ?? attempt.reference,
      amount: "100.0000",
      currency: "LYD",
      environment: "SANDBOX",
    })];
  }

  const steps: Partial<Record<Phase, FlowStep[]>> = options.steps ?? {
    INITIATE: [stepFor("INITIATE")],
    SUBMIT: [stepFor("SUBMIT")],
    VERIFY: [stepFor("VERIFY")],
    REFUND: [stepFor("REFUND")],
    VOID: [stepFor("VOID")],
    CANCEL: [stepFor("CANCEL")],
  };

  const calls: EngineHarness["calls"] = {
    reserve: [],
    release: [],
    commit: [],
    ledgerConfirmation: [],
    ledgerScenario: [],
    operatorCases: [],
    scheduled: [],
    inbox: [],
  };

  const repository: AttemptRepository = {
    async getAttempt(id: string) {
      return attempts.get(id) ?? null;
    },
    async updateAttempt(id: string, patch: DynamicAttemptPatch) {
      const target = attempts.get(id);
      if (!target) {
        throw new Error(`attempt ${id} not found`);
      }
      Object.assign(target, patch);
      return target;
    },
  };

  const slots: SlotReservationStore = {
    async reserveSlot(target) {
      calls.reserve.push(target.id);
      return { reservationId: `slot-${calls.reserve.length}` };
    },
    async releaseSlot(target) {
      calls.release.push(target.id);
    },
    async commitSlot(target) {
      calls.commit.push(target.id);
      return options.commitResult ?? { outcome: "COMMITTED", journalEntryId: `entry-${target.id}` };
    },
  };

  const executor = {
    async execute(step: FlowStep): Promise<ScriptedResult> {
      const phase = String(step.id).split("-")[0] as Phase;
      const queue = scripts[phase];
      const next = queue?.shift();
      if (next) {
        return next;
      }
      if (phase === "SUBMIT") {
        return successStep({
          status: "SUCCESS",
          reference: attempt.gatewayReference ?? attempt.reference,
          amount: attempt.totalChargedAmount,
          currency: attempt.currency,
          environment: attempt.env,
        });
      }
      return { stepId: step.id, status: "SUCCEEDED", output: { state: {}, public: {} }, logs: [] };
    },
  };

  const engine = new DynamicRailEngine({
    attempts: repository,
    slots,
    flowProvider: {
      async getSteps(phase: Phase) {
        return steps[phase] ?? [];
      },
    },
    stepExecutor: executor as never,
    ledgerPoster: {
      async postPaymentConfirmation(refId: string) {
        calls.ledgerConfirmation.push(refId);
        return { entry: { id: `ledger-${refId}` }, lines: [], created: true, idempotent: false };
      },
      async postScenario(_scenario: string, refId: string) {
        calls.ledgerScenario.push(refId);
        return { entry: { id: `ledger-${refId}` }, lines: [], created: true, idempotent: false };
      },
    },
    transactionRunner: async <R>(callback: (transaction: unknown) => Promise<R>) => callback(undefined),
    operatorCaseSink: {
      async open(input: OperatorCaseOpenInput) {
        calls.operatorCases.push(input);
        return { id: `case-${calls.operatorCases.length}` };
      },
    },
    reconciliationScheduler: {
      async schedule(attemptId: string, adjustmentId: string) {
        calls.scheduled.push({ attemptId, adjustmentId });
      },
    },
    callbackVerifier: options.callbackVerifier,
    callbackInbox: {
      async accept(channel: string, dedupeKey: string) {
        const key = `${channel}:${dedupeKey}`;
        calls.inbox.push(key);
        return calls.inbox.filter((entry) => entry === key).length === 1;
      },
    },
    now: () => new Date("2026-06-15T12:00:00.000Z"),
  } as unknown as DynamicRailEngineOptions);

  return { engine, attempts, calls, scripts, attempt };
};

export const trustedResponse = (
  attempt: DynamicAttempt,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  status: "SUCCESS",
  reference: attempt.gatewayReference ?? attempt.reference,
  amount: new Decimal(String(attempt.totalChargedAmount)).toFixed(4),
  currency: attempt.currency,
  environment: attempt.env,
  ...overrides,
});

