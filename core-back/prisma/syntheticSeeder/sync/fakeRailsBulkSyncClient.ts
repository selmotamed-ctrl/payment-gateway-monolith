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

const BATCH = 10_000;
const CONCURRENCY = 4;

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

interface Batch {
  kind: "transactions" | "events";
  rows: any[];
}

function* transactionBatches(ctx: SeederContext): Generator<Batch> {
  const routeInfo = new Map(ctx.refs.routes.map((route) => [route.id, route]));
  const railById = new Map(ctx.refs.rails.map((rail) => [rail.id, rail]));
  let batch: any[] = [];
  for (const attempt of ctx.dataset.paymentAttempts) {
    const route = routeInfo.get(String(attempt.routeId));
    const rail = route ? railById.get(route.railId) : undefined;
    const providerReference = attempt.providerReference
      ?? `FK-SEED-${String(attempt.id).slice(-12).toUpperCase()}`;
    batch.push({
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
    });
    if (batch.length >= BATCH) {
      yield { kind: "transactions", rows: batch };
      batch = [];
    }
  }
  if (batch.length > 0) yield { kind: "transactions", rows: batch };
};

function* eventBatches(ctx: SeederContext): Generator<Batch> {
  const attemptById = new Map(ctx.dataset.paymentAttempts.map((attempt) => [String(attempt.id), attempt]));
  const routeInfo = new Map(ctx.refs.routes.map((route) => [route.id, route]));
  let batch: any[] = [];
  for (const log of ctx.dataset.attemptStepLogs) {
    const attempt = attemptById.get(String(log.attemptId));
    const route = attempt ? routeInfo.get(String(attempt.routeId)) : undefined;
    batch.push({
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
    });
    if (batch.length >= BATCH) {
      yield { kind: "events", rows: batch };
      batch = [];
    }
  }
  if (batch.length > 0) yield { kind: "events", rows: batch };
};

export const fakeRailsBulkSync = async (ctx: SeederContext): Promise<{ transactions: number; events: number }> => {
  const baseUrl = process.env.FAKE_RAILS_PUBLIC_BASE_URL;
  const token = process.env.FAKE_RAILS_SEEDER_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("FAKE_RAILS_PUBLIC_BASE_URL and FAKE_RAILS_SEEDER_TOKEN are required for the bulk sync");
  }
  const endpoint = new URL("/portal-api/internal/bulk-seed", baseUrl).toString();
  let syncedTransactions = 0;
  let syncedEvents = 0;

  const send = async (batch: Batch): Promise<void> => {
    const payload = batch.kind === "transactions"
      ? { transactions: batch.rows, events: [] }
      : { transactions: [], events: batch.rows };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fake-rails-seeder-token": token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Fake Rails bulk sync failed (${batch.kind}): HTTP ${response.status} ${await response.text()}`);
    }
    if (batch.kind === "transactions") syncedTransactions += batch.rows.length;
    else syncedEvents += batch.rows.length;
  };

  const runPool = async (batches: Generator<Batch>): Promise<void> => {
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      for (const batch of batches) {
        await send(batch);
      }
    });
    const results = await Promise.allSettled(workers);
    const failure = results.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") throw failure.reason;
  };

  // Transactions must exist before the events that reference them, so the two
  // streams are drained in order while each still uses four HTTP workers.
  await runPool(transactionBatches(ctx));
  await runPool(eventBatches(ctx));
  return { transactions: syncedTransactions, events: syncedEvents };
};
