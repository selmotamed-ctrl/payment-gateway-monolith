import type { Request, Response } from "express";
import {
  findTransactionByReference,
  insertStepEvent,
  insertTransaction,
  nowIso,
  updateTransaction,
  uuidv7,
  type FakeTransactionRow,
} from "../../engine/db";
import { env } from "../../lib/env";
import { rawBodyText } from "../../lib/rawBody";
import { zMaskCard, zMaskPhone, zMaskWallet } from "../../lib/zReady";
import {
  assignFate,
  evaluate,
  latencyFor,
  type ChaosDecision,
} from "../../engine/chaos/ChaosEvaluator";
import { defaultScenario, type FailPhase, type RailChaosScenarioConfig, type RailDescriptor } from "../../engine/chaos/DefaultRailScenarios";
import { deriveOtp } from "../../engine/crypto/FakeCryptoSigner";
import { webhookDispatcher } from "../../engine/webhooks/WebhookDispatcher";
import { broadcast } from "../portal/eventHub";

export interface RailRequestContext {
  request: Request;
  response: Response;
  descriptor: RailDescriptor;
  scenario: RailChaosScenarioConfig;
  transaction: FakeTransactionRow;
  phase: FailPhase;
  body: Record<string, unknown>;
  reference: string;
  amountWire: string;
  amountLyd: string;
  currency: string;
  customer: string | null;
  mode: string;
  fault: ChaosDecision | null;
}

export interface RailResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
  contentType?: string;
}

export type RailHandler = (context: RailRequestContext) => Promise<RailResponse> | RailResponse;

export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const firstString = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
};

export const deepFind = (
  value: unknown,
  keys: readonly string[],
  depth = 0,
): string | undefined => {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const found = firstString(record[key]);
      if (found) return found;
    }
    for (const entry of Object.values(record)) {
      const found = deepFind(entry, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
};

const REFERENCE_KEYS = [
  "our_reference", "reference", "merchant_reference", "MerchantReference", "merchantReference",
  "custom_ref", "order_id", "orderId", "merchant_order_id", "merchantTransInfo",
  "external_reference", "externalReference", "request_id", "requestId", "idempotency_key",
  "client_reference", "transaction_id", "transactionId", "uuid", "ref", "store_order_id",
];

const AMOUNT_KEYS = [
  "amount", "Amount", "AmountTrxn", "total_amount", "totalAmount", "trans_amount", "transAmount",
  "funds_transfer_amount", "value", "payment_amount", "requested_amount", "amount_lyd", "price",
];

const CUSTOMER_KEYS = [
  "customer_mobile", "phone", "mobile", "msisdn", "card_number", "cardNumber", "wallet_id",
  "walletId", "pan", "customer_phone", "payer_phone", "account", "customer_id",
];

const OTP_KEYS = ["otp", "OTP", "otp_code", "otpCode", "code", "pin", "verification_code", "confirm_code"];

export const extractReference = (body: Record<string, unknown>, request: Request): string =>
  deepFind(body, REFERENCE_KEYS) ??
  request.header("idempotency-key") ??
  request.header("x-request-id") ??
  `FK-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

export const extractAmount = (body: Record<string, unknown>): string => {
  const nested = deepFind(asRecord(body.transAmount), AMOUNT_KEYS);
  return deepFind(body, AMOUNT_KEYS) ?? nested ?? "0.00";
};

export const extractCustomer = (body: Record<string, unknown>): string | null =>
  deepFind(body, CUSTOMER_KEYS) ?? null;

export const extractOtp = (body: Record<string, unknown>): string | null =>
  deepFind(body, OTP_KEYS) ?? null;

export const normalizeAmount = (
  gatewayCode: string,
  wire: string,
): { wire: string; lyd: string; scale: number } => {
  const numeric = Number(wire.replace(/[^0-9.-]/g, ""));
  const safe = Number.isFinite(numeric) ? numeric : 0;
  switch (gatewayCode) {
    case "moamalat": {
      // Moamalat transmits integer dirhams (LYD * 1000).
      const integer = /^\d+$/.test(wire.trim()) ? Number(wire.trim()) : Math.round(safe * 1000);
      return { wire: String(integer), lyd: (integer / 1000).toFixed(4), scale: 1000 };
    }
    case "ly_pay":
    case "neompay":
      return { wire: wire.trim(), lyd: safe.toFixed(4), scale: 1000 };
    default:
      return { wire: wire.trim(), lyd: safe.toFixed(4), scale: 100 };
  }
};

export const maskCustomer = (gatewayCode: string, customer: string | null): string | null => {
  if (!customer) return null;
  if (gatewayCode === "moamalat" || gatewayCode === "mpgs") return zMaskCard(customer);
  if (gatewayCode === "neompay") return zMaskWallet(customer);
  return zMaskPhone(customer);
};

export const phaseForPath = (method: string, path: string): FailPhase => {
  const normalized = path.toLowerCase();
  if (normalized.includes("refund")) return "REFUND";
  if (normalized.includes("inquiry") || normalized.includes("enquiry") || normalized.includes("status")
    || normalized.includes("filtertransactions") || normalized.includes("receipt/transaction")
    || normalized.includes("by-reference")) return "VERIFY";
  if (normalized.includes("confirm") || normalized.includes("verify") && method === "POST") return "SUBMIT";
  if (normalized.includes("statement")) return "VERIFY";
  return "INITIATE";
};

const referenceFromPath = (path: string): string | undefined => {
  const segments = path.split("/").filter(Boolean);
  const markers = ["by-reference", "status", "order", "sessions", "payments", "Payment", "funds-transfers"];
  for (const marker of markers) {
    const index = segments.indexOf(marker);
    if (index < 0) continue;
    const candidate = segments[index + 1];
    if (!candidate) continue;
    if (["open", "enquiry", "create", "requests", "by-reference", "funds-transfers", "status", "order", "sessions"].includes(candidate)) continue;
    return candidate;
  }
  return undefined;
};

export const resolveOrCreateTransaction = (input: {
  descriptor: RailDescriptor;
  request: Request;
  body: Record<string, unknown>;
  phase: FailPhase;
  scenario: RailChaosScenarioConfig;
  mode?: string;
}): { transaction: FakeTransactionRow; reference: string } => {
  const { descriptor, request, body } = input;
  const params = request.params as Record<string, string | undefined>;
  const pathReference = params.ref ?? params.id ?? params.uuid ?? referenceFromPath(request.path);
  const reference = pathReference && pathReference.trim().length > 0
    ? pathReference.trim()
    : extractReference(body, request);
  const existing = findTransactionByReference(descriptor.gatewayCode, reference);
  if (existing) {
    return { transaction: existing, reference: existing.our_reference };
  }

  const wire = extractAmount(body);
  const normalized = normalizeAmount(descriptor.gatewayCode, wire);
  const customer = extractCustomer(body);
  const scenarioSeed = `${descriptor.railCode}:${reference}`;
  const fate = assignFate(input.scenario, scenarioSeed);

  const otp = deriveOtp(env.FAKE_RAILS_SEEDER_TOKEN, descriptor.railCode, reference, descriptor.otpLength);
  const transaction: FakeTransactionRow = {
    id: uuidv7(),
    gateway_code: descriptor.gatewayCode,
    rail_code: descriptor.railCode,
    env: (deepFind(body, ["env", "environment"]) ?? "SANDBOX").toUpperCase().includes("LIVE") ? "LIVE" : "SANDBOX",
    our_reference: reference,
    provider_reference: `FK-${descriptor.railCode.toUpperCase().replace(/[^A-Z0-9]/g, "")}-${Date.now()}-${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`,
    network_reference: ["moamalat", "ly_pay", "onepay", "mpgs"].includes(descriptor.railCode)
      ? `NET-${Math.random().toString(36).slice(2, 12).toUpperCase()}`
      : null,
    idempotency_key: request.header("idempotency-key") ?? null,
    requested_amount_wire: normalized.wire,
    normalized_amount_lyd: normalized.lyd,
    settled_amount_lyd: null,
    gateway_fee_lyd: "0.0000",
    currency: (deepFind(body, ["currency", "Currency"]) ?? "LYD").toUpperCase().slice(0, 3),
    collection_mode: input.mode ?? descriptor.collectionModes[0] ?? "OTP_PULL",
    customer_identifier_masked: maskCustomer(descriptor.gatewayCode, customer),
    expected_otp: otp,
    status: "INITIATED",
    assigned_fail_phase: fate.assignedFailPhase,
    assigned_failure_mode: fate.assignedFailureMode,
    inquiry_override_status: null,
    return_url: deepFind(body, ["return_url", "returnUrl", "redirect_url", "callback_url"]) ?? null,
    cancel_url: deepFind(body, ["cancel_url", "cancelUrl"]) ?? null,
    webhook_url: deepFind(body, ["webhook_url", "webhookUrl", "notification_url"]) ?? null,
    is_seeded_historical: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insertTransaction(transaction);
  return { transaction, reference };
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const hangMs = (): number => {
  const configured = Number(process.env.FAKE_RAILS_TIMEOUT_HANG_MS ?? "20000");
  return Number.isFinite(configured) && configured > 0 ? configured : 20000;
};

/**
 * Applies a chaos decision. Returns a response when the fault fully owns the
 * reply, or `undefined` when the handler should run normally (business
 * declines are returned by the handler so the wire shape stays realistic).
 */
export const applyFault = async (
  context: RailRequestContext,
): Promise<RailResponse | undefined> => {
  const fault = context.fault;
  if (!fault) return undefined;
  switch (fault.failureMode) {
    case "TIMEOUT_HANG_ABOVE_STEP_TTL":
      await sleep(hangMs());
      return { status: 504, body: { error: "gateway_timeout", message: "Upstream switch did not respond" } };
    case "SOCKET_RESET_MID_STREAM":
      context.response.socket?.destroy();
      return { status: 499, body: {} };
    case "HTTP_500_GATEWAY_FAULT":
      return { status: fault.source === "OUTAGE" ? 503 : 500, body: { error: "gateway_fault", message: "Upstream switch internal error" } };
    case "RATE_LIMIT_HTTP_429":
      return { status: 429, body: { error: "rate_limited", message: "Too many requests" } };
    case "MALFORMED_OR_UNMAPPED_200_BODY":
      return { status: 200, body: { unexpected_schema: true, data: null, code: "??" } };
    default:
      return undefined;
  }
};

export const finalizeFault = (
  context: RailRequestContext,
  fault: ChaosDecision,
): RailResponse | undefined => {
  switch (fault.failureMode) {
    case "TERMINAL_DECLINE_INSUFFICIENT_FUNDS":
      updateTransaction(context.transaction.id, { status: "FAILED" });
      return { status: 200, body: failureBody(context, "INSUFFICIENT_FUNDS", "Insufficient funds") };
    case "LIMIT_EXCEEDED_CUSTOMER_CEILING":
      updateTransaction(context.transaction.id, { status: "FAILED" });
      return { status: 200, body: failureBody(context, "LIMIT_EXCEEDED", "Customer limit exceeded") };
    case "WRONG_OTP_RETRYABLE":
      updateTransaction(context.transaction.id, { status: "AWAITING_ACTION" });
      return {
        status: 200,
        body: {
          ...successBase(context),
          status: "AWAITING_CUSTOMER",
          error: "WRONG_OTP",
          message: "The OTP is incorrect",
          retryable: true,
        },
      };
    case "AMOUNT_ROUNDING_MISMATCH": {
      const settled = (Number(context.transaction.normalized_amount_lyd) + 0.05).toFixed(4);
      updateTransaction(context.transaction.id, { status: "PAID", settled_amount_lyd: settled });
      return { status: 200, body: { ...successBase(context), status: "PAID", settled_amount: settled } };
    }
    case "CONFLICTING_WEBHOOK_VS_INQUIRY":
      updateTransaction(context.transaction.id, { status: "PAID", inquiry_override_status: "FAILED" });
      void dispatchSuccessWebhook(context, "payment.paid");
      return { status: 200, body: { ...successBase(context), status: "PAID" } };
    default:
      return undefined;
  }
};

const successBase = (context: RailRequestContext): Record<string, unknown> => ({
  reference: context.reference,
  our_reference: context.transaction.our_reference,
  provider_reference: context.transaction.provider_reference,
  transaction_id: context.transaction.provider_reference,
  network_reference: context.transaction.network_reference,
  amount: context.transaction.normalized_amount_lyd,
  currency: context.transaction.currency,
  process_id: context.transaction.provider_reference,
});

const failureBody = (
  context: RailRequestContext,
  code: string,
  message: string,
): Record<string, unknown> => ({
  ...successBase(context),
  status: "FAILED",
  success: false,
  error: code,
  error_code: code,
  message,
  ActionCode: code === "INSUFFICIENT_FUNDS" ? "05" : "61",
});

export const successResponse = (
  context: RailRequestContext,
  status: string,
  extra: Record<string, unknown> = {},
): RailResponse => {
  updateTransaction(context.transaction.id, {
    status,
    settled_amount_lyd: status === "PAID" ? context.transaction.normalized_amount_lyd : null,
  });
  return {
    status: 200,
    body: { ...successBase(context), status, success: true, ActionCode: status === "PAID" ? "00" : "00", ...extra },
  };
};

export const dispatchSuccessWebhook = async (
  context: RailRequestContext,
  event = "payment.paid",
  extra: Record<string, unknown> = {},
): Promise<void> => {
  webhookDispatcher.dispatch({
    transaction: { ...context.transaction, status: "PAID" },
    event,
    payload: {
      ...successBase(context),
      event,
      status: "PAID",
      amount: context.transaction.normalized_amount_lyd,
      ...extra,
    },
    behavior: context.scenario.webhookBehavior,
  });
};

export const dispatchFailureWebhook = async (
  context: RailRequestContext,
  event = "payment.failed",
): Promise<void> => {
  webhookDispatcher.dispatch({
    transaction: context.transaction,
    event,
    payload: { ...failureBody(context, "DECLINED", "Payment declined"), event },
    behavior: context.scenario.webhookBehavior,
  });
};

export const recordRailEvent = (context: RailRequestContext, response: RailResponse, startedAt: number): void => {
  const eventId = uuidv7();
  insertStepEvent({
    id: eventId,
    transaction_id: context.transaction.id,
    gateway_code: context.descriptor.gatewayCode,
    phase: context.phase,
    method: context.request.method,
    path: context.request.originalUrl,
    request_headers_json: JSON.stringify(context.request.headers),
    request_body_raw: rawBodyText(context.request).slice(0, 200_000),
    response_status: response.status ?? 200,
    response_body_raw: JSON.stringify(response.body).slice(0, 200_000),
    injected_fault: context.fault?.failureMode ?? null,
    duration_ms: Date.now() - startedAt,
    created_at: nowIso(),
  });
  broadcast("rail.request", {
    eventId,
    gatewayCode: context.descriptor.gatewayCode,
    railCode: context.descriptor.railCode,
    phase: context.phase,
    method: context.request.method,
    path: context.request.originalUrl,
    status: response.status ?? 200,
    transactionId: context.transaction.id,
    ourReference: context.transaction.our_reference,
    providerReference: context.transaction.provider_reference,
    amount: context.transaction.normalized_amount_lyd,
    expectedOtp: context.transaction.expected_otp,
    fault: context.fault?.failureMode ?? null,
    durationMs: Date.now() - startedAt,
  });
};

export const applyLatency = async (context: RailRequestContext): Promise<void> => {
  const delay = latencyFor(context.scenario, `${context.transaction.id}:${context.phase}`);
  if (delay > 0) await sleep(delay);
};

export const scenarioOf = (
  scenarios: Map<string, RailChaosScenarioConfig>,
  descriptor: RailDescriptor,
): RailChaosScenarioConfig =>
  scenarios.get(descriptor.railCode) ?? scenarios.get(descriptor.gatewayCode) ?? defaultScenario(descriptor);

export const evaluateFor = (input: {
  request: Request;
  scenario: RailChaosScenarioConfig;
  phase: FailPhase;
  transaction: FakeTransactionRow;
}): ChaosDecision | null =>
  evaluate({
    request: input.request,
    config: input.scenario,
    phase: input.phase,
    pinned: {
      phase: (input.transaction.assigned_fail_phase as FailPhase | null) ?? null,
      mode: (input.transaction.assigned_failure_mode as never) ?? null,
    },
  });
