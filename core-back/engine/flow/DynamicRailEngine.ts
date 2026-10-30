import { Decimal } from "decimal.js";
import { invalidationBus, type InvalidationBus } from "../../lib/invalidationBus";
import { decimal, type DecimalInput, type LedgerPostContext, type LedgerScenario, type LedgerScenarioInput, type PaymentConfirmationInput } from "../ledger/LedgerPoster";
import { StepExecutor, type FlowStep, type StepExecutionContext, type StepExecutionResult } from "./StepExecutor";
import type {
  AdapterAttempt,
  AdapterAttemptStatus,
  AdapterClientAction,
  AdapterEvidence,
  AdapterFormData,
} from "./NativeAdapterRegistry";

export type DynamicAttempt = AdapterAttempt & {
  merchantId?: string;
  applicationId?: string;
  gatewayId?: string;
  gatewayVersionId?: string;
  routeId?: string;
  railId?: string;
  linkId?: string;
  linkKey?: string;
  credentialSetId?: string;
  commissionProfileId?: string;
  ownershipMode?: "INTERNAL" | "PLATFORM_CLEARING" | "MERCHANT_DIRECT";
  feeBearer?: "MERCHANT_ABSORBS" | "PAYER_SURCHARGE" | "SPLIT";
  platformCommissionAmount?: DecimalInput;
  netMerchantAmount?: DecimalInput;
  feeAccrual?: boolean;
  /** The amount tolerance of the pinned route (`mismatch_policy.tolerance_amount`). */
  mismatchTolerance?: DecimalInput;
  ledgerEntryId?: string;
  contextCiphertext?: string;
  publicOutputs?: Record<string, unknown>;
  adjustmentState?: string;
  substatus?: string;
};

export interface DynamicAttemptPatch {
  status?: AdapterAttemptStatus;
  substatus?: string;
  canonicalError?: string;
  otpAttempts?: number;
  pointOfNoReturn?: boolean;
  ledgerEntryId?: string;
  contextCiphertext?: string;
  publicOutputs?: Record<string, unknown>;
  adjustmentState?: string;
  providerReference?: string;
  networkReference?: string;
  settledAmount?: string;
  gatewayFeeAmount?: string;
}

export interface AttemptRepository {
  getAttempt(attemptId: string): Promise<DynamicAttempt | null>;
  updateAttempt(attemptId: string, patch: DynamicAttemptPatch, transaction?: unknown): Promise<DynamicAttempt>;
}

export interface SlotReservation {
  reservationId: string;
  linkId?: string;
}

/**
 * The outcome of committing a reserved slot.
 *
 * `COMMITTED` is the normal settlement. `SUSPENSE` means the link had no slot
 * left for this settlement (a duplicate/over settlement); the money has been
 * booked to SUSPENSE, an automatic refund adjustment was drafted and a P1
 * operator case was opened, but the merchant was NOT credited and the slot
 * counters were NOT advanced.
 */
export interface SlotCommitResult {
  outcome: "COMMITTED" | "SUSPENSE";
  journalEntryId?: string;
  adjustmentId?: string;
  operatorCaseId?: string;
  reason?: string;
}

export interface SlotReservationStore {
  reserveSlot(attempt: DynamicAttempt, transaction?: unknown): Promise<SlotReservation>;
  releaseSlot(attempt: DynamicAttempt, reason: string, transaction?: unknown): Promise<void>;
  commitSlot(attempt: DynamicAttempt, transaction?: unknown): Promise<SlotCommitResult | void>;
}

export interface FlowProvider {
  getSteps(phase: FlowPhase, attempt: DynamicAttempt): Promise<readonly FlowStep[]>;
}

export interface FormValidator {
  (formData: AdapterFormData): Promise<AdapterFormData>;
}

export interface FormNormalizer {
  (formData: AdapterFormData): AdapterFormData | Promise<AdapterFormData>;
}

export interface ContextCipher {
  encrypt(value: unknown): Promise<string>;
  decrypt(value: string): Promise<unknown>;
}

export interface CallbackVerificationResult {
  verified: boolean;
  attemptId?: string;
  evidence?: AdapterEvidence;
  mustInquire?: boolean;
  duplicate?: boolean;
  reason?: string;
}

export interface CallbackVerifier {
  verify(channel: string, rawRequest: unknown): Promise<CallbackVerificationResult>;
}

export interface CallbackInbox {
  accept(channel: string, dedupeKey: string, attemptId: string): Promise<boolean>;
}

export interface ReconciliationScheduler {
  schedule(attemptId: string, adjustmentId?: string): Promise<void> | void;
}

export interface PaymentLedgerPoster {
  postPaymentConfirmation(
    refId: string,
    input: PaymentConfirmationInput,
    context: LedgerPostContext,
    transaction?: unknown,
  ): Promise<{ entry: { id: string } }>;
  postScenario?(
    scenario: LedgerScenario,
    refId: string,
    input: LedgerScenarioInput,
    context: LedgerPostContext,
    transaction?: unknown,
  ): Promise<{ entry: { id: string } }>;
}

export interface DynamicRailTransactionRunner {
  <R>(callback: (transaction: unknown) => Promise<R>): Promise<R>;
}

export interface OperatorCaseOpenInput {
  kind: string;
  priority: "P1" | "P2" | "P3";
  attemptId: string;
  title: string;
  detail: string;
  slaDueAt: Date;
}

export interface OperatorCaseSink {
  open(input: OperatorCaseOpenInput): Promise<{ id: string; created?: boolean }>;
}

export interface ReportingEvaluationInput {
  id: string;
  merchantId?: string;
  amount: DecimalInput;
  currency: string;
  status?: AdapterAttemptStatus;
  settledAt?: Date;
}

export interface ReportingEvaluator {
  evaluate(attempt: ReportingEvaluationInput): Promise<unknown>;
}

export interface DynamicRailEngineOptions {
  attempts: AttemptRepository;
  slots: SlotReservationStore;
  flowProvider: FlowProvider;
  stepExecutor: StepExecutor;
  formValidator?: FormValidator;
  normalizer?: FormNormalizer;
  contextCipher?: ContextCipher;
  callbackVerifier?: CallbackVerifier;
  callbackInbox?: CallbackInbox;
  ledgerPoster?: PaymentLedgerPoster;
  transactionRunner?: DynamicRailTransactionRunner;
  reconciliationScheduler?: ReconciliationScheduler;
  /**
   * Resolves the credential entries of the attempt (the merchant identifiers
   * and the signing keys) so that a declarative step can address them with the
   * `CREDENTIAL` parameter source.
   */
  credentialResolver?: (attempt: DynamicAttempt) => Promise<Record<string, unknown>>;
  operatorCaseSink?: OperatorCaseSink;
  reportingEvaluator?: ReportingEvaluator;
  invalidationBus?: Pick<InvalidationBus, "publish">;
  now?: () => Date;
  panFieldNames?: readonly string[];
}

export interface ConfirmOptions {
  /**
   * Performs the durable, atomic AUTHORIZING claim of the attempt before the
   * SUBMIT phase. Returns `true` only for the single caller that changed the
   * row; every other caller must not submit.
   */
  claim?: (attemptId: string) => Promise<boolean>;
}

export type FlowPhase = "PRE_INITIATE" | "INITIATE" | "SUBMIT" | "VERIFY" | "CANCEL" | "REFUND" | "VOID";

export interface DynamicRailResult {
  attempt: DynamicAttempt;
  status: AdapterAttemptStatus;
  substatus?: string;
  canonicalError?: string;
  clientAction?: AdapterClientAction;
  /**
   * How the money of a successful settlement was routed. A `SUSPENSE`
   * settlement is still a captured payment, but it is not a normal merchant
   * credit: the caller must not treat it as a clean success.
   */
  settlement?: "NORMAL" | "SUSPENSE";
  outputs: Record<string, unknown>;
}

export const ATTEMPT_TRANSITION_TOPIC = "attempt:transition";

export interface AttemptTransitionEvent {
  attemptId: string;
  status: AdapterAttemptStatus;
  substatus?: string;
}

export interface TrustedSuccessFacts {
  status: boolean;
  reference: boolean;
  amount: boolean;
  currency: boolean;
  environment: boolean;
}

export interface TrustedSuccessResult {
  trusted: boolean;
  facts: TrustedSuccessFacts;
}

const TERMINAL_RELEASING_STATES = new Set<AdapterAttemptStatus>([
  "FAILED",
  "EXPIRED",
  "CANCELLED",
  "BLOCKED",
]);

const ALLOWED_TRANSITIONS: Record<AdapterAttemptStatus, readonly AdapterAttemptStatus[]> = {
  CREATED: ["INITIATING", "AWAITING_CUSTOMER", "VERIFYING", "BLOCKED", "CANCELLED", "EXPIRED", "FAILED"],
  INITIATING: ["AWAITING_CUSTOMER", "VERIFYING", "FAILED", "BLOCKED", "CANCELLED", "EXPIRED", "UNKNOWN"],
  // A browser callback or a return hint on a pending attempt starts an
  // inquiry: the attempt is VERIFYING while the gateway is asked (design
  // §9.1 rule 9). Without this edge the return-url flow threw
  // INVALID_ATTEMPT_TRANSITION.
  AWAITING_CUSTOMER: ["AUTHORIZING", "AWAITING_CUSTOMER", "VERIFYING", "FAILED", "CANCELLED", "EXPIRED", "BLOCKED", "UNKNOWN"],
  AUTHORIZING: ["VERIFYING", "SUCCEEDED", "FAILED", "UNKNOWN", "AWAITING_CUSTOMER"],
  VERIFYING: ["VERIFYING", "SUCCEEDED", "FAILED", "UNKNOWN", "AWAITING_CUSTOMER"],
  UNKNOWN: ["VERIFYING", "SUCCEEDED", "FAILED", "UNKNOWN"],
  SUCCEEDED: ["PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"],
  FAILED: ["SUCCEEDED"],
  EXPIRED: ["SUCCEEDED"],
  CANCELLED: [],
  BLOCKED: [],
  PARTIALLY_REFUNDED: ["PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"],
  REFUNDED: [],
  DISPUTED: ["PARTIALLY_REFUNDED", "REFUNDED"],
};

function engineError(code: string, message: string, statusCode = 400): Error {
  const error = new Error(message);
  Object.assign(error, { code, statusCode });
  return error;
}

function isRetryableOtp(error: string | undefined): boolean {
  return Boolean(error && error.toUpperCase().includes("RETRYABLE_OTP"));
}

function successStatus(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return ["SUCCESS", "SUCCEEDED", "PAID", "CAPTURED", "CONFIRMED", "APPROVED"].includes(value.toUpperCase());
}

function nestedEvidence(evidence: AdapterEvidence): Record<string, unknown> {
  const nested = evidence.trustedFacts;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : evidence;
}

interface PhaseExecution {
  status: AdapterAttemptStatus;
  substatus?: string;
  canonicalError?: string;
  response?: unknown;
  rawText?: string;
  outputs: {
    state: Record<string, unknown>;
    public: Record<string, unknown>;
    settledAmount?: DecimalInput;
    providerFee?: DecimalInput;
    providerReference?: string;
    networkReference?: string;
  };
  clientAction?: AdapterClientAction;
}

export class DynamicRailEngine {
  private readonly options: DynamicRailEngineOptions;
  private readonly now: () => Date;
  private readonly transitionBus: Pick<InvalidationBus, "publish">;

  constructor(options: DynamicRailEngineOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.transitionBus = options.invalidationBus ?? invalidationBus;
  }

  async preInitiate(attempt: DynamicAttempt, formData: AdapterFormData): Promise<DynamicRailResult> {
    const current = await this.getAttempt(attempt.id);
    const normalized = await this.normalizeAndValidate(formData, false);
    const execution = await this.executePhase("PRE_INITIATE", current, normalized);
    await this.persistOutputs(current, execution);
    return this.toResult(current, execution);
  }

  async initiate(
    attempt: DynamicAttempt,
    formData: AdapterFormData,
    options: { slotReserved?: boolean } = {},
  ): Promise<DynamicRailResult> {
    const current = await this.getAttempt(attempt.id);
    const normalized = await this.normalizeAndValidate(formData, true);
    const preInitiateSteps = await this.options.flowProvider.getSteps("PRE_INITIATE", current);
    if (preInitiateSteps.length > 0) {
      const preExecution = await this.executeSteps("PRE_INITIATE", current, normalized, preInitiateSteps);
      await this.persistOutputs(current, preExecution);
      if (preExecution.status === "FAILED" || preExecution.status === "BLOCKED") {
        await this.transition(current, preExecution.status);
        if (options.slotReserved === true) {
          await this.releaseSlot(current, preExecution.status);
        }
        return this.toResult(current, preExecution);
      }
    }
    // The attempt-creation guard may already own the reservation (design §9.1
    // rule 2). The reservation must have exactly one owner, otherwise a
    // single-use link would be reserved twice and the second reservation would
    // always find no free slot.
    let reserved = options.slotReserved === true;
    if (!reserved) {
      try {
        await this.options.slots.reserveSlot(current);
        reserved = true;
      } catch (error) {
        throw engineError("SLOT_RESERVATION_FAILED", error instanceof Error ? error.message : "Payment slot is unavailable", 409);
      }
    }
    try {
      await this.transition(current, "INITIATING");
      const execution = await this.executePhase("INITIATE", current, normalized);
      await this.persistOutputs(current, execution);
      if (execution.status === "UNKNOWN") {
        await this.transition(current, "UNKNOWN");
      } else if (execution.status === "FAILED" || execution.status === "BLOCKED") {
        await this.transition(current, execution.status);
        await this.releaseSlot(current, execution.status);
      } else {
        await this.transition(current, "AWAITING_CUSTOMER", {
          publicOutputs: execution.outputs.public,
        });
      }
      return this.toResult(current, execution);
    } catch (error) {
      if (reserved) {
        await this.releaseSlot(current, "INITIATE_FAILED");
      }
      throw error;
    } finally {
      this.wipePanFields(normalized);
    }
  }

  async confirm(
    attempt: DynamicAttempt,
    evidence: AdapterEvidence,
    options: ConfirmOptions = {},
  ): Promise<DynamicRailResult> {
    const current = await this.getAttempt(attempt.id);
    if (current.status === "SUCCEEDED") {
      return this.toResult(current, {
        status: "SUCCEEDED",
        outputs: { state: {}, public: current.publicOutputs ?? {} },
      });
    }
    if (options.claim) {
      // The caller owns the atomic attempt-state claim. Only the winner runs
      // the SUBMIT stack; a loser (including a duplicate key or an UNKNOWN
      // attempt past the point of no return) returns the persisted state and
      // never contacts the gateway again.
      const claimed = await options.claim(current.id);
      if (!claimed) {
        const latest = await this.getAttempt(current.id);
        return this.toResult(latest, {
          status: latest.status,
          outputs: { state: {}, public: latest.publicOutputs ?? {} },
        });
      }
      current.status = "AUTHORIZING";
      current.pointOfNoReturn = true;
      await this.transitionBus.publish(ATTEMPT_TRANSITION_TOPIC, {
        attemptId: current.id,
        status: "AUTHORIZING",
      } satisfies AttemptTransitionEvent);
    } else {
      if (current.status === "UNKNOWN" && current.pointOfNoReturn) {
        throw engineError("POINT_OF_NO_RETURN", "A money-moving attempt in UNKNOWN cannot be resubmitted", 409);
      }
      await this.transition(current, "AUTHORIZING", { pointOfNoReturn: true });
    }
    const execution = await this.executePhase("SUBMIT", current, evidence);
    await this.persistOutputs(current, execution);
    if (execution.status === "UNKNOWN") {
      await this.transition(current, "UNKNOWN");
      return this.toResult(current, execution);
    }
    if (execution.status === "AWAITING_CUSTOMER" && isRetryableOtp(execution.canonicalError)) {
      return this.handleRetryableOtp(current, execution);
    }
    if (execution.status === "FAILED") {
      await this.transition(current, "FAILED");
      await this.releaseSlot(current, "FAILED");
      return this.toResult(current, execution);
    }
    if (execution.status === "VERIFYING") {
      await this.transition(current, "VERIFYING");
      return this.toResult(current, execution);
    }
    const combinedEvidence = {
      ...evidence,
      ...(execution.response && typeof execution.response === "object" ? execution.response as Record<string, unknown> : {}),
    };
    const trusted = this.verifyTrustedSuccessFacts(combinedEvidence, current);
    if (!trusted.trusted) {
      await this.transition(current, "UNKNOWN", { canonicalError: "TRUSTED_SUCCESS_FACTS_FAILED" });
      return {
        attempt: current,
        status: "UNKNOWN",
        canonicalError: "TRUSTED_SUCCESS_FACTS_FAILED",
        outputs: execution.outputs.public,
      };
    }
    const finalized = await this.finalizeSuccess(current, combinedEvidence);
    return this.successResult(current, execution.outputs.public, finalized);
  }

  async verifyCallback(channel: string, rawRequest: unknown): Promise<DynamicRailResult> {
    if (!this.options.callbackVerifier) {
      throw engineError("CALLBACK_VERIFIER_MISSING", "Callback verifier is not configured", 501);
    }
    const verification = await this.options.callbackVerifier.verify(channel, rawRequest);
    if (!verification.verified || !verification.attemptId) {
      throw engineError("CALLBACK_VERIFICATION_FAILED", verification.reason ?? "Callback verification failed", 401);
    }
    const current = await this.getAttempt(verification.attemptId);
    const dedupeKey = this.callbackDedupeKey(channel, rawRequest, verification.attemptId);
    if (this.options.callbackInbox) {
      const accepted = await this.options.callbackInbox.accept(channel, dedupeKey, verification.attemptId);
      if (!accepted) {
        return this.toResult(current, {
          status: current.status,
          outputs: { state: {}, public: current.publicOutputs ?? {} },
        });
      }
    }
    const evidence = verification.evidence ?? {};
    const environment = nestedEvidence(evidence).environment ?? nestedEvidence(evidence).env;
    if (environment !== undefined && String(environment) !== current.env) {
      throw engineError("CALLBACK_ENVIRONMENT_MISMATCH", "Callback environment does not match the attempt", 409);
    }
    if (verification.mustInquire) {
      const inquiry = await this.inquire(current);
      if (inquiry.status === "SUCCEEDED") {
        return inquiry;
      }
      return inquiry;
    }
    const trusted = this.verifyTrustedSuccessFacts(evidence, current);
    if (!trusted.trusted) {
      await this.transition(current, "UNKNOWN", { canonicalError: "TRUSTED_SUCCESS_FACTS_FAILED" });
      return {
        attempt: current,
        status: "UNKNOWN",
        canonicalError: "TRUSTED_SUCCESS_FACTS_FAILED",
        outputs: current.publicOutputs ?? {},
      };
    }
    const finalized = await this.finalizeSuccess(current, evidence);
    return this.successResult(current, current.publicOutputs ?? {}, finalized);
  }

  async inquire(attempt: DynamicAttempt): Promise<DynamicRailResult> {
    const current = await this.getAttempt(attempt.id);
    if (current.status === "SUCCEEDED") {
      return this.toResult(current, {
        status: "SUCCEEDED",
        outputs: { state: {}, public: current.publicOutputs ?? {} },
      });
    }
    // A late success may arrive after the attempt was already FAILED or
    // EXPIRED. Those states may still transition to SUCCEEDED, so the inquiry
    // runs without first forcing the attempt back into VERIFYING.
    const lateSuccessCandidate = current.status === "FAILED" || current.status === "EXPIRED";
    if (!lateSuccessCandidate && current.status !== "UNKNOWN" && current.status !== "VERIFYING") {
      await this.transition(current, "VERIFYING");
    }
    const execution = await this.executePhase("VERIFY", current, {});
    await this.persistOutputs(current, execution);
    if (execution.status === "UNKNOWN") {
      await this.transition(current, "UNKNOWN");
      return this.toResult(current, execution);
    }
    if (execution.status === "FAILED") {
      const context = await this.readContext(current);
      if (context.trustedSuccessObserved === true) {
        await this.transition(current, "UNKNOWN", { canonicalError: "CONFLICTING_TRUSTED_SIGNALS" });
        await this.openOperatorCase({
          kind: "CONFLICT",
          priority: "P1",
          attemptId: current.id,
          title: "Conflicting trusted signals",
          detail:
            `Attempt ${current.id} received a failure signal from the gateway while a trusted success `
            + "had already been observed. The attempt is frozen in UNKNOWN for operator review.",
          slaDueAt: this.slaDueAt(4),
        });
        return this.toResult(current, {
          status: "UNKNOWN",
          canonicalError: "CONFLICTING_TRUSTED_SIGNALS",
          outputs: execution.outputs.public,
        });
      }
      await this.transition(current, "FAILED");
      await this.releaseSlot(current, "INQUIRY_FAILED");
      return this.toResult(current, execution);
    }
    if (execution.status === "VERIFYING" || execution.status === "AWAITING_CUSTOMER") {
      await this.transition(current, execution.status);
      return this.toResult(current, execution);
    }
    const response = execution.response && typeof execution.response === "object"
      ? execution.response as Record<string, unknown>
      : {};
    const trusted = this.verifyTrustedSuccessFacts(response, current);
    if (!trusted.trusted) {
      await this.transition(current, "UNKNOWN", { canonicalError: "TRUSTED_SUCCESS_FACTS_FAILED" });
      return this.toResult(current, {
        status: "UNKNOWN",
        canonicalError: "TRUSTED_SUCCESS_FACTS_FAILED",
        outputs: execution.outputs.public,
      });
    }
    const finalized = await this.finalizeSuccess(current, response);
    return this.successResult(current, execution.outputs.public, finalized);
  }

  async refund(attempt: DynamicAttempt, amount: DecimalInput, adjustmentId: string): Promise<DynamicRailResult> {
    const current = await this.getAttempt(attempt.id);
    const refundAmount = decimal(amount);
    if (!refundAmount.isFinite() || refundAmount.lte(0)) {
      throw engineError("INVALID_REFUND_AMOUNT", "Refund amount must be greater than zero");
    }
    if (refundAmount.gt(decimal(current.totalChargedAmount))) {
      throw engineError("REFUND_AMOUNT_EXCEEDED", "Refund amount exceeds the settled amount");
    }
    const phase: FlowPhase = current.settledAmount === undefined ? "VOID" : "REFUND";
    await this.options.attempts.updateAttempt(current.id, { adjustmentState: "EXECUTING" });
    const execution = await this.executePhase(phase, current, { amount: refundAmount.toFixed(4), adjustmentId });
    if (execution.status === "UNKNOWN") {
      await this.options.attempts.updateAttempt(current.id, { adjustmentState: "EXECUTING" });
      await this.options.reconciliationScheduler?.schedule(current.id, adjustmentId);
      return this.toResult(current, {
        status: "UNKNOWN",
        canonicalError: execution.canonicalError,
        outputs: execution.outputs.public,
      });
    }
    if (execution.status === "FAILED") {
      await this.options.attempts.updateAttempt(current.id, { adjustmentState: "EXECUTING" });
      await this.options.reconciliationScheduler?.schedule(current.id, adjustmentId);
      return this.toResult(current, execution);
    }
    if (this.options.ledgerPoster?.postScenario) {
      const split = this.refundSplit(current, refundAmount);
      const scenario: LedgerScenario = current.ownershipMode === "INTERNAL" ? "INTERNAL_REFUND" : "FULL_REFUND";
      await this.options.ledgerPoster.postScenario(
        scenario,
        adjustmentId,
        {
          amount: refundAmount,
          commissionAmount: split.commission,
          merchantAmount: split.merchant,
        },
        this.ledgerContext(current),
      );
    }
    const fullyRefunded = refundAmount.eq(decimal(current.totalChargedAmount));
    await this.transition(current, fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED", {
      adjustmentState: "EXECUTED",
    });
    return this.toResult(current, {
      status: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED",
      outputs: execution.outputs.public,
    });
  }

  verifyTrustedSuccessFacts(
    evidence: AdapterEvidence,
    attempt: DynamicAttempt,
  ): TrustedSuccessResult {
    const values = nestedEvidence(evidence);
    const status = successStatus(values.status ?? values.payment_status ?? values.result);
    const expectedReference = attempt.gatewayReference ?? attempt.reference;
    const evidenceReference = values.reference ?? values.provider_reference ?? values.transaction_id ?? values.gateway_reference;
    const reference = Boolean(evidenceReference)
      && (expectedReference === undefined || String(evidenceReference) === String(expectedReference));
    const evidenceAmount = values.amount ?? values.settled_amount ?? values.total_charged_amount;
    const amount = evidenceAmount !== undefined
      && this.amountWithinTolerance(evidenceAmount as DecimalInput, attempt);
    const currency = Boolean(values.currency)
      && String(values.currency).toUpperCase() === String(attempt.currency).toUpperCase();
    const environment = Boolean(values.environment ?? values.env)
      && String(values.environment ?? values.env) === String(attempt.env);
    const facts: TrustedSuccessFacts = { status, reference, amount, currency, environment };
    return {
      trusted: Object.values(facts).every(Boolean),
      facts,
    };
  }

  /**
   * The settled amount must match the charged amount within the tolerance of
   * the pinned route. A gateway that rounds by a fraction of a minor unit is
   * not a reason to declare the outcome unknown.
   */
  private amountWithinTolerance(value: DecimalInput, attempt: DynamicAttempt): boolean {
    const charged = decimal(attempt.totalChargedAmount);
    const settled = decimal(value);
    if (!settled.isFinite()) {
      return false;
    }
    if (settled.eq(charged)) {
      return true;
    }
    const tolerance = attempt.mismatchTolerance === undefined
      ? new Decimal(0)
      : decimal(attempt.mismatchTolerance);
    if (!tolerance.isFinite() || tolerance.lte(0)) {
      return false;
    }
    return settled.minus(charged).abs().lte(tolerance);
  }

  async transition(
    attempt: DynamicAttempt,
    nextStatus: AdapterAttemptStatus,
    patch: DynamicAttemptPatch = {},
  ): Promise<DynamicAttempt> {
    if (attempt.status !== nextStatus && !ALLOWED_TRANSITIONS[attempt.status].includes(nextStatus)) {
      throw engineError(
        "INVALID_ATTEMPT_TRANSITION",
        `Attempt cannot transition from ${attempt.status} to ${nextStatus}`,
        409,
      );
    }
    attempt.status = nextStatus;
    const updated = await this.options.attempts.updateAttempt(attempt.id, { status: nextStatus, ...patch });
    await this.transitionBus.publish(ATTEMPT_TRANSITION_TOPIC, {
      attemptId: attempt.id,
      status: nextStatus,
      substatus: patch.substatus,
    } satisfies AttemptTransitionEvent);
    return updated;
  }

  private async getAttempt(attemptId: string): Promise<DynamicAttempt> {
    const attempt = await this.options.attempts.getAttempt(attemptId);
    if (!attempt) {
      throw engineError("ATTEMPT_NOT_FOUND", `Attempt '${attemptId}' does not exist`, 404);
    }
    return attempt;
  }

  private async normalizeAndValidate(
    formData: AdapterFormData,
    validate: boolean,
  ): Promise<AdapterFormData> {
    const normalized = this.options.normalizer ? await this.options.normalizer(formData) : { ...formData };
    if (!validate || !this.options.formValidator) {
      return normalized;
    }
    return this.options.formValidator(normalized);
  }

  private async executePhase(
    phase: FlowPhase,
    attempt: DynamicAttempt,
    input: AdapterFormData,
  ): Promise<PhaseExecution> {
    const steps = await this.options.flowProvider.getSteps(phase, attempt);
    return this.executeSteps(phase, attempt, input, steps);
  }

  private async executeSteps(
    phase: FlowPhase,
    attempt: DynamicAttempt,
    input: AdapterFormData,
    steps: readonly FlowStep[],
  ): Promise<PhaseExecution> {
    const state = await this.readContext(attempt);
    const publicOutputs = { ...attempt.publicOutputs };
    let response: unknown;
    let rawText: string | undefined;
    let clientAction: AdapterClientAction | undefined;
    const storedFields = (attempt.context as { fields?: Record<string, unknown> } | undefined)?.fields;
    const customerFields = { ...storedFields, ...input };
    const credentials = this.options.credentialResolver
      ? await this.options.credentialResolver(attempt)
      : undefined;
    // The declarative outputs that the step executor resolves (the settled
    // amount, the provider fee and the provider/network references) have to be
    // carried out of the phase, otherwise the attempt is never enriched with
    // the facts the gateway reported.
    let settledAmount: DecimalInput | undefined;
    let providerFee: DecimalInput | undefined;
    let providerReference: string | undefined;
    let networkReference: string | undefined;
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (!step) {
        continue;
      }
      const context: StepExecutionContext = {
        attempt: attempt as unknown as Record<string, unknown>,
        customerFields,
        credentials,
        state,
        previousResponse: response,
        urls: attempt.context?.urls as Record<string, unknown> | undefined,
        transformContext: {
          templateValues: customerFields,
        },
        panFieldNames: this.options.panFieldNames,
      };
      const result = await this.options.stepExecutor.execute(step, context);
      Object.assign(state, result.output.state);
      Object.assign(publicOutputs, result.output.public);
      if (result.output.settledAmount !== undefined) {
        settledAmount = result.output.settledAmount as DecimalInput;
      }
      if (result.output.providerFee !== undefined) {
        providerFee = result.output.providerFee as DecimalInput;
      }
      if (result.output.providerReference !== undefined) {
        providerReference = String(result.output.providerReference);
      }
      if (result.output.networkReference !== undefined) {
        networkReference = String(result.output.networkReference);
      }
      response = result.response;
      rawText = result.rawText ?? rawText;
      clientAction = this.clientActionFrom(result) ?? clientAction;
      if (String(result.status) === "BLOCKED") {
        return {
          status: "BLOCKED",
          substatus: result.substatus,
          canonicalError: result.canonicalError,
          response,
          rawText,
          outputs: {
            state,
            public: publicOutputs,
            settledAmount,
            providerFee,
            providerReference,
            networkReference,
          },
          clientAction,
        };
      }
      const resultStatus = result.status;
      if (resultStatus === "UNKNOWN") {
        return {
          status: "UNKNOWN",
          substatus: result.substatus,
          canonicalError: result.canonicalError,
          response,
          rawText,
          outputs: {
            state,
            public: publicOutputs,
            settledAmount,
            providerFee,
            providerReference,
            networkReference,
          },
          clientAction,
        };
      }
      if (resultStatus === "FAILED") {
        return {
          status: "FAILED",
          substatus: result.substatus,
          canonicalError: result.canonicalError,
          response,
          rawText,
          outputs: {
            state,
            public: publicOutputs,
            settledAmount,
            providerFee,
            providerReference,
            networkReference,
          },
          clientAction,
        };
      }
      if (resultStatus === "AWAITING_CUSTOMER" || resultStatus === "VERIFYING") {
        return {
          status: resultStatus,
          substatus: result.substatus,
          canonicalError: result.canonicalError,
          response,
          rawText,
          outputs: {
            state,
            public: publicOutputs,
            settledAmount,
            providerFee,
            providerReference,
            networkReference,
          },
          clientAction,
        };
      }
      if (result.branch) {
        // A branch decides where the phase continues: the referenced step is
        // the next one and the rest of the current stack is skipped.
        const target = result.branch === "then" ? step.branch?.thenStepId : step.branch?.elseStepId;
        if (!target) {
          break;
        }
        const targetIndex = steps.findIndex(
          (candidate, candidateIndex) => candidateIndex > index && candidate.id === target,
        );
        if (targetIndex === -1) {
          break;
        }
        index = targetIndex - 1;
      }
    }
    const status = this.phaseStatus(phase, steps.length > 0);
    return {
      status,
      response,
      rawText,
      outputs: {
        state,
        public: publicOutputs,
        settledAmount,
        providerFee,
        providerReference,
        networkReference,
      },
      clientAction,
    };
  }

  private phaseStatus(phase: FlowPhase, hasSteps: boolean): AdapterAttemptStatus {
    if (!hasSteps) {
      return phase === "SUBMIT" ? "SUCCEEDED" : "AWAITING_CUSTOMER";
    }
    return "SUCCEEDED";
  }

  private clientActionFrom(result: StepExecutionResult): AdapterClientAction | undefined {
    const candidate = result.output.public.clientAction;
    if (candidate && typeof candidate === "object" && "type" in candidate && "payload" in candidate) {
      return candidate as AdapterClientAction;
    }
    const actionType = result.output.public.actionType ?? result.output.public.type;
    if (typeof actionType === "string") {
      const payload = { ...result.output.public };
      delete payload.actionType;
      delete payload.type;
      return { type: actionType as AdapterClientAction["type"], payload };
    }
    return undefined;
  }

  private async persistOutputs(
    attempt: DynamicAttempt,
    execution: PhaseExecution,
  ): Promise<void> {
    const contextCiphertext = this.options.contextCipher
      ? await this.options.contextCipher.encrypt(execution.outputs.state)
      : attempt.contextCiphertext;
    const settledAmount = execution.outputs.settledAmount === undefined
      ? undefined
      : decimal(execution.outputs.settledAmount).toFixed(4);
    await this.options.attempts.updateAttempt(attempt.id, {
      contextCiphertext,
      publicOutputs: execution.outputs.public,
      providerReference: execution.outputs.providerReference,
      networkReference: execution.outputs.networkReference,
      settledAmount,
    });
    if (contextCiphertext !== undefined) {
      attempt.contextCiphertext = contextCiphertext;
    }
    attempt.publicOutputs = execution.outputs.public;
    if (execution.outputs.providerReference !== undefined) {
      attempt.providerReference = execution.outputs.providerReference;
    }
    if (execution.outputs.networkReference !== undefined) {
      attempt.networkReference = execution.outputs.networkReference;
    }
    if (settledAmount !== undefined) {
      attempt.settledAmount = settledAmount;
    }
  }

  private async handleRetryableOtp(
    attempt: DynamicAttempt,
    execution: PhaseExecution,
  ): Promise<DynamicRailResult> {
    const nextAttempts = (attempt.otpAttempts ?? 0) + 1;
    const maximum = attempt.maxOtpAttempts ?? 3;
    if (nextAttempts >= maximum) {
      await this.transition(attempt, "FAILED", { otpAttempts: nextAttempts });
      await this.releaseSlot(attempt, "FAILED");
      return this.toResult(attempt, {
        status: "FAILED",
        canonicalError: "RETRYABLE_OTP",
        outputs: execution.outputs,
      });
    }
    await this.transition(attempt, "AWAITING_CUSTOMER", {
      otpAttempts: nextAttempts,
      canonicalError: "RETRYABLE_OTP",
    });
    return this.toResult(attempt, {
      status: "AWAITING_CUSTOMER",
      canonicalError: "RETRYABLE_OTP",
      outputs: execution.outputs,
    });
  }

  private async finalizeSuccess(
    attempt: DynamicAttempt,
    _evidence: AdapterEvidence,
  ): Promise<SlotCommitResult> {
    const previousStatus = attempt.status;
    const post = async (transaction?: unknown): Promise<string> => {
      if (!this.options.ledgerPoster) {
        return `unposted:${attempt.id}`;
      }
      // The base amount is the requested amount; the surcharge is added on
      // top of it by the payer-surcharge templates.
      const amount = decimal(attempt.requestedAmount);
      const commission = this.commissionForAttempt(attempt);
      const surcharge = decimal(attempt.surchargeAmount ?? 0);
      const merchantAmount = attempt.netMerchantAmount === undefined
        ? amount.minus(commission)
        : decimal(attempt.netMerchantAmount);
      // The route fee is ONE economic amount. The ledger template decides how
      // it is booked: deducted at source (`PROVIDER_FEE_EXPENSE`) or accrued
      // until the T+N settlement (`GATEWAY_FEE_EXPENSE` + `GATEWAY_FEE_ACCRUAL`).
      // The fee therefore has to be supplied under both names, otherwise a
      // confirmation could never be posted.
      const gatewayFee = attempt.gatewayFeeAmount === undefined
        ? undefined
        : decimal(attempt.gatewayFeeAmount);
      const result = await this.options.ledgerPoster.postPaymentConfirmation(
        attempt.id,
        {
          ownershipMode: attempt.ownershipMode ?? "PLATFORM_CLEARING",
          feeBearer: attempt.feeBearer ?? "MERCHANT_ABSORBS",
          feeAccrual: attempt.feeAccrual,
          amount,
          surchargeAmount: surcharge,
          commissionAmount: commission,
          merchantAmount,
          ...(gatewayFee === undefined
            ? {}
            : { gatewayFeeAmount: gatewayFee, providerFeeAmount: gatewayFee }),
        },
        this.ledgerContext(attempt),
        transaction,
      );
      return result.entry.id;
    };

    const finalize = async (transaction?: unknown): Promise<SlotCommitResult> => {
      // The slot decision comes first: it either advances the counters (the
      // normal path) or books the money to SUSPENSE and drafts the refund. All
      // three effects - the slot decision, the journal posting and the
      // SUCCEEDED status - use this same transaction, so they commit or roll
      // back together (design §9.1 rules 6 and 7).
      const commit = await this.options.slots.commitSlot(attempt, transaction);
      if (commit?.outcome === "SUSPENSE") {
        await this.options.attempts.updateAttempt(attempt.id, {
          status: "SUCCEEDED",
          substatus: "SUSPENSE_SETTLEMENT",
          ...(commit.journalEntryId ? { ledgerEntryId: commit.journalEntryId } : {}),
        }, transaction);
        return commit;
      }
      const ledgerEntryId = await post(transaction);
      await this.options.attempts.updateAttempt(attempt.id, {
        status: "SUCCEEDED",
        ledgerEntryId,
      }, transaction);
      return { outcome: "COMMITTED", journalEntryId: ledgerEntryId };
    };

    const runner = this.options.transactionRunner;
    const result = runner ? await runner(finalize) : await finalize();
    attempt.status = "SUCCEEDED";
    if (result.outcome === "SUSPENSE") {
      attempt.substatus = "SUSPENSE_SETTLEMENT";
    }
    await this.transitionBus.publish(ATTEMPT_TRANSITION_TOPIC, {
      attemptId: attempt.id,
      status: "SUCCEEDED",
      substatus: attempt.substatus,
    } satisfies AttemptTransitionEvent);
    const context = await this.readContext(attempt);
    context.trustedSuccessObserved = true;
    if (this.options.contextCipher) {
      await this.options.attempts.updateAttempt(attempt.id, {
        contextCiphertext: await this.options.contextCipher.encrypt(context),
      });
    }
    if (previousStatus === "FAILED" || previousStatus === "EXPIRED") {
      await this.openOperatorCase({
        kind: "LATE_SUCCESS",
        priority: "P2",
        attemptId: attempt.id,
        title: "Late success recovered",
        detail:
          `Attempt ${attempt.id} succeeded after it had reached ${previousStatus}`
          + (result.outcome === "SUSPENSE" ? " and was routed to SUSPENSE" : "")
          + ". Verify the customer notification and the merchant credit.",
        slaDueAt: this.slaDueAt(24),
      });
    }
    await this.evaluateReporting(attempt);
    return result;
  }

  private async evaluateReporting(attempt: DynamicAttempt): Promise<void> {
    if (!this.options.reportingEvaluator) {
      return;
    }
    try {
      await this.options.reportingEvaluator.evaluate({
        id: attempt.id,
        merchantId: attempt.merchantId,
        amount: attempt.settledAmount ?? attempt.totalChargedAmount ?? attempt.requestedAmount,
        currency: attempt.currency,
        status: "SUCCEEDED",
        settledAt: this.now(),
      });
    } catch {
      return;
    }
  }

  private async openOperatorCase(input: OperatorCaseOpenInput): Promise<void> {
    if (!this.options.operatorCaseSink) {
      return;
    }
    await this.options.operatorCaseSink.open(input);
  }

  private slaDueAt(hours: number): Date {
    return new Date(this.now().getTime() + hours * 60 * 60 * 1000);
  }

  /**
   * The result of a successful settlement. A settlement that was routed to
   * SUSPENSE is not reported as a clean success: it carries the distinct
   * settlement marker and the substatus, so the caller cannot mistake it for a
   * normal merchant credit.
   */
  private successResult(
    attempt: DynamicAttempt,
    outputs: Record<string, unknown>,
    finalized: SlotCommitResult,
  ): DynamicRailResult {
    if (finalized.outcome === "SUSPENSE") {
      return {
        attempt,
        status: "SUCCEEDED",
        substatus: "SUSPENSE_SETTLEMENT",
        canonicalError: "SLOT_ALREADY_SETTLED_SUSPENSE",
        settlement: "SUSPENSE",
        outputs,
      };
    }
    return {
      attempt,
      status: "SUCCEEDED",
      settlement: "NORMAL",
      outputs,
    };
  }

  /**
   * The platform commission is always taken from the pinned commission profile
   * that was snapshotted onto the attempt. There is deliberately no default
   * rate: a booking without a resolved commission must never silently use a
   * hard coded percentage.
   */
  private commissionForAttempt(attempt: DynamicAttempt): Decimal {
    const pinned = attempt.platformCommissionAmount;
    if (pinned !== undefined) {
      return decimal(pinned);
    }
    const context = attempt.context ?? {};
    const contextual = context.platformCommissionAmount;
    if (contextual !== undefined) {
      return decimal(contextual as DecimalInput);
    }
    throw engineError(
      "COMMISSION_NOT_RESOLVED",
      "The platform commission must be resolved from the pinned commission profile",
    );
  }

  private refundSplit(attempt: DynamicAttempt, amount: Decimal): { commission: Decimal; merchant: Decimal } {
    const total = decimal(attempt.totalChargedAmount);
    const commission = total.isZero() ? new Decimal(0) : this.commissionForAttempt(attempt).mul(amount).div(total);
    return { commission, merchant: amount.minus(commission) };
  }

  private ledgerContext(attempt: DynamicAttempt): LedgerPostContext {
    return {
      merchantId: attempt.merchantId,
      gatewayId: attempt.gatewayId,
      credentialSetId: attempt.credentialSetId,
      env: attempt.env,
      currency: attempt.currency,
    };
  }

  private async readContext(attempt: DynamicAttempt): Promise<Record<string, unknown>> {
    if (this.options.contextCipher && attempt.contextCiphertext) {
      const decrypted = await this.options.contextCipher.decrypt(attempt.contextCiphertext);
      return decrypted && typeof decrypted === "object" ? decrypted as Record<string, unknown> : {};
    }
    return { ...attempt.context };
  }

  private async releaseSlot(attempt: DynamicAttempt, reason: string): Promise<void> {
    if (TERMINAL_RELEASING_STATES.has(attempt.status)) {
      await this.options.slots.releaseSlot(attempt, reason);
    }
  }

  private callbackDedupeKey(channel: string, rawRequest: unknown, attemptId: string): string {
    if (rawRequest && typeof rawRequest === "object") {
      const candidate = rawRequest as { dedupeKey?: unknown; dedupe_key?: unknown };
      const explicit = candidate.dedupeKey ?? candidate.dedupe_key;
      if (explicit !== undefined) {
        return `${channel}:${String(explicit)}`;
      }
    }
    return `${channel}:${attemptId}`;
  }

  private toResult(
    attempt: DynamicAttempt,
    execution: {
      status: AdapterAttemptStatus;
      substatus?: string;
      canonicalError?: string;
      outputs: Record<string, unknown> | { state: Record<string, unknown>; public: Record<string, unknown> };
      clientAction?: AdapterClientAction;
    },
  ): DynamicRailResult {
    const rawOutputs = execution.outputs as Record<string, unknown>;
    const outputs: Record<string, unknown> = typeof rawOutputs.public === "object" && rawOutputs.public !== null
      ? rawOutputs.public as Record<string, unknown>
      : rawOutputs;
    return {
      attempt,
      status: execution.status,
      substatus: execution.substatus,
      canonicalError: execution.canonicalError,
      clientAction: execution.clientAction,
      outputs,
    };
  }

  private wipePanFields(formData: AdapterFormData): void {
    const names = new Set((this.options.panFieldNames ?? []).map((name) => name.toLowerCase()));
    for (const [key, value] of Object.entries(formData)) {
      if (names.has(key.toLowerCase())) {
        if (Buffer.isBuffer(value)) {
          value.fill(0);
        }
        delete formData[key];
      }
    }
  }
}
