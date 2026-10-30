import { Router } from "express";
import { z } from "zod";
import { getDb, nowIso, type FakeStepEventRow, type FakeTransactionRow } from "../../engine/db";
import { parseOrThrow } from "../../lib/error";
import { RAIL_DESCRIPTORS } from "../../engine/chaos/DefaultRailScenarios";
import { broadcast } from "./eventHub";

const transactionSchema = z.object({
  id: z.string().min(1),
  gateway_code: z.string().min(1),
  rail_code: z.string().min(1),
  env: z.string().default("SANDBOX"),
  our_reference: z.string().min(1),
  provider_reference: z.string().min(1),
  network_reference: z.string().nullable().optional(),
  idempotency_key: z.string().nullable().optional(),
  requested_amount_wire: z.string(),
  normalized_amount_lyd: z.string(),
  settled_amount_lyd: z.string().nullable().optional(),
  gateway_fee_lyd: z.string().default("0.0000"),
  currency: z.string().default("LYD"),
  collection_mode: z.string(),
  customer_identifier_masked: z.string().nullable().optional(),
  expected_otp: z.string().nullable().optional(),
  status: z.string(),
  assigned_fail_phase: z.string().nullable().optional(),
  assigned_failure_mode: z.string().nullable().optional(),
  inquiry_override_status: z.string().nullable().optional(),
  return_url: z.string().nullable().optional(),
  cancel_url: z.string().nullable().optional(),
  webhook_url: z.string().nullable().optional(),
  is_seeded_historical: z.number().int().min(0).max(1).default(1),
  created_at: z.string(),
  updated_at: z.string(),
});

const eventSchema = z.object({
  id: z.string().min(1),
  transaction_id: z.string().nullable().optional(),
  gateway_code: z.string().min(1),
  phase: z.string().min(1),
  method: z.string().min(1),
  path: z.string().min(1),
  request_headers_json: z.string().default("{}"),
  request_body_raw: z.string().default(""),
  response_status: z.number().int().nullable().optional(),
  response_body_raw: z.string().nullable().optional(),
  injected_fault: z.string().nullable().optional(),
  duration_ms: z.number().int().min(0).default(0),
  created_at: z.string(),
});

const batchSchema = z.object({
  transactions: z.array(transactionSchema).max(5000).default([]),
  events: z.array(eventSchema).max(5000).default([]),
});

const toTransactionRow = (value: z.infer<typeof transactionSchema>): FakeTransactionRow => ({
  id: value.id,
  gateway_code: value.gateway_code,
  rail_code: value.rail_code,
  env: value.env,
  our_reference: value.our_reference,
  provider_reference: value.provider_reference,
  network_reference: value.network_reference ?? null,
  idempotency_key: value.idempotency_key ?? null,
  requested_amount_wire: value.requested_amount_wire,
  normalized_amount_lyd: value.normalized_amount_lyd,
  settled_amount_lyd: value.settled_amount_lyd ?? null,
  gateway_fee_lyd: value.gateway_fee_lyd,
  currency: value.currency,
  collection_mode: value.collection_mode,
  customer_identifier_masked: value.customer_identifier_masked ?? null,
  expected_otp: value.expected_otp ?? null,
  status: value.status,
  assigned_fail_phase: value.assigned_fail_phase ?? null,
  assigned_failure_mode: value.assigned_failure_mode ?? null,
  inquiry_override_status: value.inquiry_override_status ?? null,
  return_url: value.return_url ?? null,
  cancel_url: value.cancel_url ?? null,
  webhook_url: value.webhook_url ?? null,
  is_seeded_historical: value.is_seeded_historical,
  created_at: value.created_at,
  updated_at: value.updated_at,
});

const toEventRow = (value: z.infer<typeof eventSchema>): FakeStepEventRow => ({
  id: value.id,
  transaction_id: value.transaction_id ?? null,
  gateway_code: value.gateway_code,
  phase: value.phase,
  method: value.method,
  path: value.path,
  request_headers_json: value.request_headers_json,
  request_body_raw: value.request_body_raw,
  response_status: value.response_status ?? null,
  response_body_raw: value.response_body_raw ?? null,
  injected_fault: value.injected_fault ?? null,
  duration_ms: value.duration_ms,
  created_at: value.created_at,
});

const parseNdjson = (raw: string): unknown[] =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

export const createSeederSyncRouter = (): Router => {
  const router = Router();

  router.post("/seeder-handshake", (request, response) => {
    const db = getDb();
    const counts = db
      .prepare("SELECT COUNT(*) AS count FROM fake_transactions")
      .get() as { count: number };
    response.json({
      ok: true,
      service: "fake-rails-back",
      ready: true,
      rails: RAIL_DESCRIPTORS.length,
      transactionCount: counts.count,
      at: nowIso(),
      check: (request.body as { check?: string } | undefined)?.check ?? null,
    });
  });

  router.post("/bulk-seed", (request, response) => {
    const payload =
      typeof request.body === "string"
        ? { transactions: parseNdjson(request.body), events: [] }
        : Array.isArray(request.body)
          ? { transactions: request.body, events: [] }
          : request.body;
    const batch = parseOrThrow(batchSchema, payload);
    const db = getDb();
    const insertTransaction = db.prepare(
      `INSERT OR REPLACE INTO fake_transactions (
        id, gateway_code, rail_code, env, our_reference, provider_reference, network_reference,
        idempotency_key, requested_amount_wire, normalized_amount_lyd, settled_amount_lyd,
        gateway_fee_lyd, currency, collection_mode, customer_identifier_masked, expected_otp,
        status, assigned_fail_phase, assigned_failure_mode, inquiry_override_status,
        return_url, cancel_url, webhook_url, is_seeded_historical, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertEvent = db.prepare(
      `INSERT OR REPLACE INTO fake_step_events (
        id, transaction_id, gateway_code, phase, method, path, request_headers_json,
        request_body_raw, response_status, response_body_raw, injected_fault, duration_ms, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const value of batch.transactions) {
        const row = toTransactionRow(value);
        insertTransaction.run(
          row.id, row.gateway_code, row.rail_code, row.env, row.our_reference, row.provider_reference,
          row.network_reference, row.idempotency_key, row.requested_amount_wire, row.normalized_amount_lyd,
          row.settled_amount_lyd, row.gateway_fee_lyd, row.currency, row.collection_mode,
          row.customer_identifier_masked, row.expected_otp, row.status, row.assigned_fail_phase,
          row.assigned_failure_mode, row.inquiry_override_status, row.return_url, row.cancel_url,
          row.webhook_url, row.is_seeded_historical, row.created_at, row.updated_at,
        );
      }
      for (const value of batch.events) {
        const row = toEventRow(value);
        insertEvent.run(
          row.id, row.transaction_id, row.gateway_code, row.phase, row.method, row.path,
          row.request_headers_json, row.request_body_raw, row.response_status, row.response_body_raw,
          row.injected_fault, row.duration_ms, row.created_at,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    broadcast("seeder.bulk", {
      transactions: batch.transactions.length,
      events: batch.events.length,
    });
    response.json({
      ok: true,
      insertedTransactions: batch.transactions.length,
      insertedEvents: batch.events.length,
      at: nowIso(),
    });
  });

  return router;
};
