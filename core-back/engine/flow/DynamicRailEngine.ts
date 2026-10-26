import { Decimal } from "decimal.js";
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
  credentialSetId?: string;
  commissionProfileId?: string;
  ownershipMode?: "INTERNAL" | "PLATFORM_CLEARING" | "MERCHANT_DIRECT";
  feeBearer?: "MERCHANT_ABSORBS" | "PAYER_SURCHARGE" | "SPLIT";
  ledgerEntryId?: string;
  contextCiphertext?: string;
  publicOutputs?: Record<string, unknown>;
  adjustmentState?: string;
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

export interface SlotReservationStore {
  reserveSlot(attempt: DynamicAttempt, transaction?: unknown): Promise<SlotReservation>;
  releaseSlot(attempt: DynamicAttempt, reason: string, transaction?: unknown): Promise<void>;
  commitSlot(attempt: DynamicAttempt, transaction?: unknown): Promise<void>;
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
  now?: () => Date;
  panFieldNames?: readonly string[];
}

export type FlowPhase = "PRE_INITIATE" | "INITIATE" | "SUBMIT" | "VERIFY" | "CANCEL" | "REFUND" | "VOID";

export interface DynamicRailResult {
  attempt: DynamicAttempt;
  status: AdapterAttemptStatus;
  substatus?: string;
  canonicalError?: string;
  clientAction?: AdapterClientAction;
  outputs: Record<string, unknown>;
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
  CREATED: ["INITIATING", "AWAITING_CUSTOMER", "BLOCKED", "CANCELLED", "EXPIRED", "FAILED"],
  INITIATING: ["AWAITING_CUSTOMER", "VERIFYING", "FAILED", "BLOCKED", "CANCELLED", "EXPIRED", "UNKNOWN"],
  AWAITING_CUSTOMER: ["AUTHORIZING", "AWAITING_CUSTOMER", "FAILED", "CANCELLED", "EXPIRED", "BLOCKED", "UNKNOWN"],
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

export class DynamicRailEngine {
  private readonly options: DynamicRailEngineOptions;
  private readonly now: () => Date;

  constructor(options: DynamicRailEngineOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  async preInitiate(attempt: DynamicAttempt, formData: AdapterFormData): Promise<DynamicRailResult> {
    const current = await this.getAttempt(attempt.id);
    const normalized = await this.normalizeAndValidate(formData, false);
    const execution = await this.executePhase("PRE_INITIATE", current, normalized);
    await this.persistOutputs(current, execution);
    return this.toResult(current, execution);
  }

  async initiate(attempt: DynamicAttempt, formData: AdapterFormData): Promise<DynamicRailResult> {
    const current = await this.getAttempt(attempt.id);
    const normalized = await this.normalizeAndValidate(formData, true);
    let reserved = false;
    try {
      await this.options.slots.reserveSlot(current);
      reserved = true;
    } catch (error) {
      throw engineError("SLOT_RESERVATION_FAILED", error instanceof Error ? error.message : "Payment slot is unavailable", 409);
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

  async confirm(attempt: DynamicAttempt, evidence: AdapterEvidence): Promise<DynamicRailResult> {
    const current = await this.getAttempt(attempt.id);
    if (current.status === "SUCCEEDED") {
      return this.toResult(current, {
        status: "SUCCEEDED",
        outputs: { state: {}, public: current.publicOutputs ?? {} },
      });
    }
    if (current.status === "UNKNOWN" && current.pointOfNoReturn) {
      throw engineError("POINT_OF_NO_RETURN", "A money-moving attempt in UNKNOWN cannot be resubmitted", 409);
    }
    await this.transition(current, "AUTHORIZING", { pointOfNoReturn: true });
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
    await this.finalizeSuccess(current, combinedEvidence);
    return {
      attempt: current,
      status: "SUCCEEDED",
      outputs: execution.outputs.public,
    };
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
    await this.finalizeSuccess(current, evidence);
    return {
      attempt: current,
      status: "SUCCEEDED",
      outputs: current.publicOutputs ?? {},
    };
  }

  async inquire(attempt: DynamicAttempt): Promise<DynamicRailResult> {
    const current = await this.getAttempt(attempt.id);
    if (current.status === "SUCCEEDED") {
      return this.toResult(current, {
        status: "SUCCEEDED",
        outputs: { state: {}, public: current.publicOutputs ?? {} },
      });
    }
    if (current.status !== "UNKNOWN" && current.status !== "VERIFYING") {
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
    await this.finalizeSuccess(current, response);
    return {
      attempt: current,
      status: "SUCCEEDED",
      outputs: execution.outputs.public,
    };
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
      && decimal(evidenceAmount as DecimalInput).eq(decimal(attempt.totalChargedAmount));
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
    return this.options.attempts.updateAttempt(attempt.id, { status: nextStatus, ...patch });
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
  ): Promise<{
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
  }> {
    const steps = await this.options.flowProvider.getSteps(phase, attempt);
    const state = await this.readContext(attempt);
    const publicOutputs = { ...(attempt.publicOutputs ?? {}) };
    let response: unknown;
    let rawText: string | undefined;
    let clientAction: AdapterClientAction | undefined;
    for (const step of steps) {
      const context: StepExecutionContext = {
        attempt: attempt as unknown as Record<string, unknown>,
        customerFields: input,
        state,
        previousResponse: response,
        urls: attempt.context?.urls as Record<string, unknown> | undefined,
        transformContext: {
          templateValues: input,
        },
        panFieldNames: this.options.panFieldNames,
      };
      const result = await this.options.stepExecutor.execute(step, context);
      Object.assign(state, result.output.state);
      Object.assign(publicOutputs, result.output.public);
      response = result.response;
      rawText = result.rawText ?? rawText;
      clientAction = this.clientActionFrom(result) ?? clientAction;
      if (result.status === "UNKNOWN") {
        return {
          status: "UNKNOWN",
          substatus: result.substatus,
          canonicalError: result.canonicalError,
          response,
          rawText,
          outputs: { state, public: publicOutputs },
          clientAction,
        };
      }
      if (result.status === "FAILED") {
        return {
          status: "FAILED",
          substatus: result.substatus,
          canonicalError: result.canonicalError,
          response,
          rawText,
          outputs: { state, public: publicOutputs },
          clientAction,
        };
      }
      if (result.status === "AWAITING_CUSTOMER" || result.status === "VERIFYING") {
        return {
          status: result.status,
          substatus: result.substatus,
          canonicalError: result.canonicalError,
          response,
          rawText,
          outputs: { state, public: publicOutputs },
          clientAction,
        };
      }
    }
    const status = this.phaseStatus(phase, steps.length > 0);
    return { status, response, rawText, outputs: { state, public: publicOutputs }, clientAction };
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
    execution: Awaited<ReturnType<DynamicRailEngine["executePhase"]>>,
  ): Promise<void> {
    const contextCiphertext = this.options.contextCipher
      ? await this.options.contextCipher.encrypt(execution.outputs.state)
      : attempt.contextCiphertext;
    await this.options.attempts.updateAttempt(attempt.id, {
      contextCiphertext,
      publicOutputs: execution.outputs.public,
      providerReference: execution.outputs.providerReference,
      networkReference: execution.outputs.networkReference,
      settledAmount: execution.outputs.settledAmount === undefined
        ? undefined
        : decimal(execution.outputs.settledAmount).toFixed(4),
    });
  }

  private async handleRetryableOtp(
    attempt: DynamicAttempt,
    execution: Awaited<ReturnType<DynamicRailEngine["executePhase"]>>,
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

  private async finalizeSuccess(attempt: DynamicAttempt, evidence: AdapterEvidence): Promise<void> {
    const post = async (transaction?: unknown): Promise<string> => {
      if (!this.options.ledgerPoster) {
        return `unposted:${attempt.id}`;
      }
      const amount = decimal(attempt.totalChargedAmount);
      const commission = this.commissionForAttempt(attempt, amount);
      const result = await this.options.ledgerPoster.postPaymentConfirmation(
        attempt.id,
        {
          ownershipMode: attempt.ownershipMode ?? "PLATFORM_CLEARING",
          feeBearer: attempt.feeBearer ?? "MERCHANT_ABSORBS",
          amount,
          commissionAmount: commission,
          merchantAmount: amount.minus(commission),
        },
        this.ledgerContext(attempt),
        transaction,
      );
      return result.entry.id;
    };
    const runner = this.options.transactionRunner;
    if (runner) {
      await runner(async (transaction) => {
        const ledgerEntryId = await post(transaction);
        await this.options.attempts.updateAttempt(attempt.id, {
          status: "SUCCEEDED",
          ledgerEntryId,
        }, transaction);
      });
    } else {
      const ledgerEntryId = await post();
      await this.options.attempts.updateAttempt(attempt.id, {
        status: "SUCCEEDED",
        ledgerEntryId,
      });
    }
    attempt.status = "SUCCEEDED";
    await this.options.slots.commitSlot(attempt);
    const context = await this.readContext(attempt);
    context.trustedSuccessObserved = true;
    if (this.options.contextCipher) {
      await this.options.attempts.updateAttempt(attempt.id, {
        contextCiphertext: await this.options.contextCipher.encrypt(context),
      });
    }
  }

  private commissionForAttempt(attempt: DynamicAttempt, amount: Decimal): Decimal {
    const context = attempt.context ?? {};
    const commission = context.platformCommissionAmount;
    if (commission !== undefined) {
      return decimal(commission as DecimalInput);
    }
    return amount.mul("0.03");
  }

  private refundSplit(attempt: DynamicAttempt, amount: Decimal): { commission: Decimal; merchant: Decimal } {
    const total = decimal(attempt.totalChargedAmount);
    const commission = total.isZero() ? new Decimal(0) : this.commissionForAttempt(attempt, total).mul(amount).div(total);
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
    return { ...(attempt.context ?? {}) };
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
