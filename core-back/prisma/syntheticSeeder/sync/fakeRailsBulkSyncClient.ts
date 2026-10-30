import type { SeederContext } from "../context";
import { OTP_CODES } from "../libyanDataCatalog";

/**
 * Streams the seeded attempts and step logs into the standalone Fake Rails
 * SQLite store (`POST /portal-api/internal/bulk-seed`).
 *
 * After the sync, "Inquire now" on a seeded UNKNOWN attempt, a refund on a
 * seeded SUCCEEDED attempt and the statement reconciliation all hit the
 * emulator and receive a coherent answer.
 */

const BATCH = 5000;

const STATUS_MAP: Record<string, string> = {
  SUCCEEDED: "PAID",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  BLOCKED: "FAILED",
  REFUNDED: "REFUNDED",
  PARTIALLY_REFUNDED: "REFUNDED",
  DISPUTED: "DISPUTED",
  CREATED: "INITIATED",
  INITIATING: "INITIATED",
  AWAITING_CUSTOMER: "AWAITING_ACTION",
  AUTHORIZING: "AWAITING_ACTION",
  VERIFYING: "AWAITING_ACTION",
  UNKNOWN: "UNKNOWN_SIMULATED",
};

const toIso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

export const fakeRailsBulkSync = async (ctx: SeederContext): Promise<{ transactions: number; events: number }> => {
  const baseUrl = process.env.FAKE_RAILS_PUBLIC_BASE_URL;
  const token = process.env.FAKE_RAILS_SEEDER_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("FAKE_RAILS_PUBLIC_BASE_URL and FAKE_RAILS_SEEDER_TOKEN are required for the bulk sync");
  }
  const endpoint = new URL("/portal-api/internal/bulk-seed", baseUrl).toString();
  const routeByAttempt = new Map(ctx.dataset.paymentAttempts.map((attempt) => [attempt.id, attempt.routeId]));
  const routeInfo = new Map(ctx.refs.routes.map((route) => [route.id, route]));
  const railById = new Map(ctx.refs.rails.map((rail) => [rail.id, rail]));
  void routeByAttempt;

  const transactions = ctx.dataset.paymentAttempts.map((attempt) => {
    const route = routeInfo.get(String(attempt.routeId));
    const rail = route ? railById.get(route.railId) : undefined;
    const providerReference = attempt.providerReference
      ?? `FK-SEED-${String(attempt.id).slice(-12).toUpperCase()}`;
    return {
      id: String(attempt.id),
      gateway_code: route?.gatewayCode ?? "neompay",
      rail_code: route?.railCode ?? rail?.code ?? "neompay",
      env: String(attempt.env),
      our_reference: String(attempt.reference),
      provider_reference: providerReference,
      network_reference: attempt.networkReference ?? null,
      idempotency_key: attempt.idempotencyKey ?? null,
      requested_amount_wire: String(attempt.gatewayAmountWire ?? attempt.totalChargedAmount),
      normalized_amount_lyd: String(attempt.totalChargedAmount),
      settled_amount_lyd: attempt.settledAmount ?? null,
      gateway_fee_lyd: String(attempt.gatewayFeeAmount ?? "0.0000"),
      currency: String(attempt.currency),
      collection_mode: rail?.collectionMode ?? "HYBRID",
      customer_identifier_masked: attempt.customerFieldsMasked?.phone ?? null,
      expected_otp: OTP_CODES[Number(String(attempt.id).slice(-2)) % OTP_CODES.length],
      status: STATUS_MAP[String(attempt.status)] ?? "INITIATED",
      assigned_fail_phase: null,
      assigned_failure_mode: null,
      inquiry_override_status: null,
      return_url: null,
      cancel_url: null,
      webhook_url: null,
      is_seeded_historical: 1,
      created_at: toIso(attempt.createdAt),
      updated_at: toIso(attempt.updatedAt),
    };
  });

  const events = ctx.dataset.attemptStepLogs.map((log) => {
    const attempt = ctx.dataset.paymentAttempts.find((candidate) => candidate.id === log.attemptId);
    const route = attempt ? routeInfo.get(String(attempt.routeId)) : undefined;
    return {
      id: String(log.id),
      transaction_id: String(log.attemptId),
      gateway_code: route?.gatewayCode ?? "neompay",
      phase: String(log.phase),
      method: "POST",
      path: `/rails/${route?.gatewayCode ?? "neompay"}/${String(log.phase).toLowerCase()}`,
      request_headers_json: JSON.stringify({ "content-type": "application/json" }),
      request_body_raw: JSON.stringify(log.redactedRequestJson ?? {}),
      response_status: log.httpStatus ?? 200,
      response_body_raw: String(log.redactedResponseText ?? ""),
      injected_fault: null,
      duration_ms: Number(log.durationMs ?? 0),
      created_at: toIso(log.createdAt),
    };
  });

  let syncedTransactions = 0;
  let syncedEvents = 0;
  for (let offset = 0; offset < transactions.length; offset += BATCH) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fake-rails-seeder-token": token,
      },
      body: JSON.stringify({ transactions: transactions.slice(offset, offset + BATCH), events: [] }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Fake Rails bulk sync failed (transactions): HTTP ${response.status} ${await response.text()}`);
    }
    syncedTransactions += transactions.slice(offset, offset + BATCH).length;
  }
  for (let offset = 0; offset < events.length; offset += BATCH) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fake-rails-seeder-token": token,
      },
      body: JSON.stringify({ transactions: [], events: events.slice(offset, offset + BATCH) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Fake Rails bulk sync failed (events): HTTP ${response.status} ${await response.text()}`);
    }
    syncedEvents += events.slice(offset, offset + BATCH).length;
  }
  return { transactions: syncedTransactions, events: syncedEvents };
};
