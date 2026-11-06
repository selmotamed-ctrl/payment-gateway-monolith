import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { client } from "../../prisma/client";
import { adminOperationsRouter } from "../../api/internal/adminOperations";
import { createRow } from "../exhaustive/_dbFactory";
import { exhaustiveClient } from "../exhaustive/_harness";
import { createStaffUser, dbAvailable, makePrincipal, startApp, uid, type TestApp } from "./harness";

let app: TestApp;
let userId: string;
const operator = () => makePrincipal(userId, ["attempt:read", "case:read", "gateway:read"], "OPERATOR");

type Row = Record<string, any>;

const makeAttempt = async (overrides: Row = {}): Promise<Row> =>
  createRow("payment_attempts", {
    status: "SUCCEEDED",
    currency: "LYD",
    requested_amount: "125.5000",
    total_charged_amount: "125.5000",
    reference: uid("PA"),
    ...overrides,
  });

const makeInbound = (attempt: Row | null, gatewayId: string, channelId: string, overrides: Row = {}) =>
  createRow("inbound_events", {
    gateway_id: gatewayId,
    channel_id: channelId,
    attempt_id: attempt?.id ?? null,
    verified: true,
    received_at: new Date(),
    dedupe_key: randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    ...overrides,
  });

/** The gateway and a confirmation channel of the attempt's route. */
const routeOf = async (attempt: Row): Promise<{ gatewayId: string; channelId: string; routeId: string }> => {
  const route = await client.railRoute.findUniqueOrThrow({ where: { id: attempt.route_id } });
  const channel = await createRow("confirmation_channels", { route_id: route.id });
  return { gatewayId: route.gatewayId, channelId: channel.id as string, routeId: route.id };
};

if (dbAvailable) beforeAll(async () => {
  userId = await createStaffUser("OPERATOR");
  app = await startApp([adminOperationsRouter]);
  app.setPrincipal(operator());
});
if (dbAvailable) beforeEach(() => app.setPrincipal(operator()));
if (dbAvailable) afterAll(async () => {
  await app.close();
  await client.$disconnect();
  await exhaustiveClient().$disconnect();
});

describe.skipIf(!dbAvailable)("attempt detail", () => {
  test("returns the full detail shape, keeps `attempt`, and leaks no secret", async () => {
    const attempt = await makeAttempt({ context_ciphertext: "CTX-CIPHERTEXT-SECRET-VALUE", provider_reference: "prov-ref-1" });
    const { gatewayId, channelId } = await routeOf(attempt);
    const rawMarker = "RAW-BODY-SECRET-MARKER";
    const event = await makeInbound(attempt, gatewayId, channelId, {
      raw_body_bytes: Buffer.from(`{"note":"${rawMarker}"}`),
      redacted_headers_json: { "x-signature": "[REDACTED]" },
    });
    await createRow("attempt_step_logs", {
      attempt_id: attempt.id,
      gateway_version_id: attempt.gateway_version_id,
      phase: "INITIATE",
      step_order: 2,
      redacted_request_json: { authorization: "Bearer leaked-bearer-value", amount: "125.5000" },
      redacted_response_text: "ok",
      http_status: 200,
      duration_ms: 41,
      outcome: "SUCCESS",
    });
    await createRow("attempt_step_logs", {
      attempt_id: attempt.id,
      gateway_version_id: attempt.gateway_version_id,
      phase: "PREPARE",
      step_order: 1,
      redacted_request_json: {},
      redacted_response_text: "first",
      outcome: "SUCCESS",
    });
    const operatorCase = await createRow("operator_cases", { attempt_id: attempt.id, state: "OPEN", kind: "UNKNOWN", priority: "P1" });
    const dispute = await createRow("disputes", {
      attempt_id: attempt.id,
      gateway_id: gatewayId,
      rail_id: attempt.rail_id,
      amount: "10.0000",
      reason_code: "4853",
    });
    const wallet = await createRow("gl_accounts", { account_type: "MERCHANT_WALLET", currency: "LYD" });
    const adjustment = await createRow("adjustments", {
      source_attempt_id: attempt.id,
      target_gl_account_id: wallet.id,
      amount: "5.0000",
      type: "REFUND",
      state: "DRAFT",
    });
    await makeAttempt({ attempt_group_id: attempt.attempt_group_id, link_id: attempt.link_id, status: "FAILED" });

    const result = await app.request("GET", `/attempts/${attempt.id}`);
    expect(result.status).toBe(200);
    const body = result.json;
    expect(Object.keys(body)).toEqual(expect.arrayContaining([
      "attempt", "merchant", "application", "rail", "gateway", "stepLogs", "inboundEvents",
      "attemptGroup", "operatorCases", "disputes", "adjustments",
    ]));
    expect(body.attempt.id).toBe(attempt.id);
    expect(body.attempt.requestedAmount).toBe("125.5000");
    expect(body.attempt.providerReference).toBe("prov-ref-1");
    expect(body.merchant.id).toBe(attempt.merchant_id);
    expect(body.merchant).toHaveProperty("legalName");
    expect(body.application).toMatchObject({ id: attempt.application_id });
    expect(body.rail).toMatchObject({ id: attempt.rail_id });
    expect(body.gateway.id).toBe(gatewayId);

    expect(body.stepLogs.map((log: Row) => log.stepOrder)).toEqual([1, 2]);
    expect(body.stepLogs[1]).toMatchObject({ phase: "INITIATE", httpStatus: 200, durationMs: 41, outcome: "SUCCESS" });
    expect(body.stepLogs[1].redactedRequestJson.authorization).toBe("[REDACTED]");
    expect(body.stepLogs[1].redactedRequestJson.amount).toBe("125.5000");

    expect(body.inboundEvents).toHaveLength(1);
    expect(body.inboundEvents[0].id).toBe(event.id);
    expect(body.attemptGroup.id).toBe(attempt.attempt_group_id);
    expect(body.attemptGroup.attempts).toHaveLength(2);
    expect(body.operatorCases).toEqual([expect.objectContaining({ id: operatorCase.id, state: "OPEN", priority: "P1" })]);
    expect(body.disputes).toEqual([expect.objectContaining({ id: dispute.id, disputedAmount: "10.0000", reasonCode: "4853" })]);
    expect(body.adjustments).toEqual([expect.objectContaining({ id: adjustment.id, type: "REFUND", state: "DRAFT", amount: "5.0000" })]);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("CTX-CIPHERTEXT-SECRET-VALUE");
    expect(serialized).not.toContain("contextCiphertext");
    expect(serialized).not.toContain(rawMarker);
    expect(serialized).not.toContain("rawBodyBytes");
    expect(serialized).not.toContain("leaked-bearer-value");
  });

  test("SUPPORT sees no amounts or provider references; unknown id is 404; authority is required", async () => {
    const attempt = await makeAttempt({ provider_reference: "prov-ref-support" });
    app.setPrincipal(makePrincipal(userId, ["attempt:read"], "SUPPORT"));
    const support = await app.request("GET", `/attempts/${attempt.id}`);
    expect(support.status).toBe(200);
    expect(support.json.attempt.requestedAmount).toBeNull();
    expect(support.json.attempt.providerReference).toBeNull();
    expect(support.json.redactedFields).toContain("amounts");
    expect(JSON.stringify(support.json)).not.toContain("prov-ref-support");

    app.setPrincipal(operator());
    expect((await app.request("GET", `/attempts/${randomUUID()}`)).json.code).toBe("PAYMENT_ATTEMPT_NOT_FOUND");
    app.setPrincipal(makePrincipal(userId, ["finance:read"]));
    expect((await app.request("GET", `/attempts/${attempt.id}`)).status).toBe(403);
    app.setPrincipal(operator());
  });
});

describe.skipIf(!dbAvailable)("transactions", () => {
  test("filters, hasOpenCase, redaction for SUPPORT and authorities", async () => {
    const open = await makeAttempt({ status: "UNKNOWN", reference: uid("OPEN"), currency: "USD", requested_amount: "900.0000" });
    await createRow("operator_cases", { attempt_id: open.id, state: "OPEN", kind: "UNKNOWN", priority: "P2" });
    const resolved = await makeAttempt({ status: "FAILED", reference: uid("RES"), currency: "USD", requested_amount: "10.0000" });
    await createRow("operator_cases", { attempt_id: resolved.id, state: "RESOLVED", kind: "UNKNOWN", priority: "P3" });

    const list = await app.request("GET", `/transactions?currency=USD&createdAtFrom=${new Date(Date.now() - 3600_000).toISOString()}&pageSize=200`);
    expect(list.status).toBe(200);
    const byId = new Map<string, Row>(list.json.transactions.map((item: Row) => [item.id, item]));
    expect(byId.get(open.id as string)).toMatchObject({
      status: "UNKNOWN", requestedAmount: "900.0000", currency: "USD", hasOpenCase: true,
      merchantId: open.merchant_id, applicationId: open.application_id, railId: open.rail_id,
    });
    expect(byId.get(open.id as string)!.merchant).toHaveProperty("tradeName");
    expect(byId.get(open.id as string)!.gateway).toHaveProperty("code");
    expect(byId.get(open.id as string)!.rail).toHaveProperty("nameEn");
    expect(byId.get(resolved.id as string)!.hasOpenCase).toBe(false);

    const failedOnly = await app.request("GET", `/transactions?status=FAILED,EXPIRED&merchantId=${resolved.merchant_id}`);
    expect(failedOnly.json.transactions.map((t: Row) => t.id)).toEqual([resolved.id]);
    const byRef = await app.request("GET", `/transactions?search=${open.reference}`);
    expect(byRef.json.transactions.map((t: Row) => t.id)).toEqual([open.id]);
    const byAmount = await app.request("GET", `/transactions?amountMin=500&currency=USD&merchantId=${open.merchant_id}`);
    expect(byAmount.json.transactions.map((t: Row) => t.id)).toEqual([open.id]);
    const byApp = await app.request("GET", `/transactions?applicationId=${open.application_id}&railId=${open.rail_id}`);
    expect(byApp.json.transactions.map((t: Row) => t.id)).toEqual([open.id]);
    expect((await app.request("GET", "/transactions?status=BOGUS")).status).toBe(400);
    expect((await app.request("GET", "/transactions?amountMin=abc")).status).toBe(400);
    expect((await app.request("GET", "/transactions?merchantId=nope")).status).toBe(400);

    app.setPrincipal(makePrincipal(userId, ["merchant:read"], "SUPPORT"));
    const support = await app.request("GET", `/transactions?search=${open.reference}`);
    expect(support.status).toBe(200);
    expect(support.json.transactions[0].requestedAmount).toBeNull();
    expect(support.json.transactions[0].redactedFields).toContain("amounts");
    app.setPrincipal(makePrincipal(userId, ["gateway:read"]));
    expect((await app.request("GET", "/transactions")).status).toBe(403);
    expect((await app.request("GET", "/transactions/summary")).status).toBe(403);
    app.setPrincipal(operator());
  });

  test("summary groups the last 24h by status class and counts escalated attempts", async () => {
    const before = (await app.request("GET", "/transactions/summary")).json;
    const ok = await makeAttempt({ status: "SUCCEEDED" });
    const flight = await makeAttempt({ status: "VERIFYING" });
    await makeAttempt({ status: "EXPIRED" });
    await createRow("operator_cases", { attempt_id: flight.id, state: "IN_PROGRESS", kind: "UNKNOWN", priority: "P1" });
    await createRow("operator_cases", { attempt_id: ok.id, state: "RESOLVED", kind: "UNKNOWN", priority: "P3" });
    const after = (await app.request("GET", "/transactions/summary")).json;
    expect(after.total24h - before.total24h).toBe(3);
    expect(after.settled24h - before.settled24h).toBe(1);
    expect(after.inFlight24h - before.inFlight24h).toBe(1);
    expect(after.failed24h - before.failed24h).toBe(1);
    expect(after.escalated24h - before.escalated24h).toBe(1);
  });
});

describe.skipIf(!dbAvailable)("inbound events", () => {
  test("filters verified=false and unmatchedOnly; list never carries the body", async () => {
    const attempt = await makeAttempt();
    const { gatewayId, channelId } = await routeOf(attempt);
    const matched = await makeInbound(attempt, gatewayId, channelId, { raw_body_bytes: Buffer.from("MATCHED-BODY-MARKER") });
    const unmatched = await makeInbound(null, gatewayId, channelId, {
      verified: false,
      verification_error: "bad signature",
      raw_body_bytes: Buffer.from("UNMATCHED-BODY-MARKER"),
    });

    const base = `/inbound-events?gatewayId=${gatewayId}`;
    const all = await app.request("GET", base);
    expect(all.status).toBe(200);
    expect(all.json.inboundEvents.map((e: Row) => e.id).sort()).toEqual([matched.id, unmatched.id].sort());
    expect(JSON.stringify(all.json)).not.toContain("BODY-MARKER");
    expect(JSON.stringify(all.json)).not.toContain("rawBodyBytes");

    const notVerified = await app.request("GET", `${base}&verified=false`);
    expect(notVerified.json.inboundEvents.map((e: Row) => e.id)).toEqual([unmatched.id]);
    expect(notVerified.json.inboundEvents[0]).toMatchObject({ verified: false, verificationError: "bad signature", attemptId: null });
    const verifiedOnly = await app.request("GET", `${base}&verified=true`);
    expect(verifiedOnly.json.inboundEvents.map((e: Row) => e.id)).toEqual([matched.id]);
    const unmatchedOnly = await app.request("GET", `${base}&unmatchedOnly=true`);
    expect(unmatchedOnly.json.inboundEvents.map((e: Row) => e.id)).toEqual([unmatched.id]);
    expect(unmatchedOnly.json.inboundEvents[0].gateway.id).toBe(gatewayId);
    expect((await app.request("GET", `${base}&verified=maybe`)).status).toBe(400);
    const ranged = await app.request("GET", `${base}&from=2000-01-01&to=2000-01-02`);
    expect(ranged.json.inboundEvents).toEqual([]);
  });

  test("detail returns redacted headers and a redacted 2KB preview, size and sha256", async () => {
    const attempt = await makeAttempt();
    const { gatewayId, channelId } = await routeOf(attempt);
    const json = JSON.stringify({ status: "PAID", token: "tok-super-secret-1", amount: "5.0000", filler: "x".repeat(5000) });
    const event = await makeInbound(attempt, gatewayId, channelId, {
      raw_body_bytes: Buffer.from(json),
      redacted_headers_json: { "content-type": "application/json", authorization: "Bearer header-secret-2" },
    });
    const form = await makeInbound(null, gatewayId, channelId, {
      raw_body_bytes: Buffer.from("status=PAID&signature=sig-secret-3&amount=5"),
    });
    const detail = await app.request("GET", `/inbound-events/${event.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.id).toBe(event.id);
    expect(detail.json.bodySize).toBe(json.length);
    expect(detail.json.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.json.bodyPreview.length).toBeLessThanOrEqual(2048);
    expect(detail.json.bodyPreview).toContain("PAID");
    expect(detail.json.bodyPreview).not.toContain("tok-super-secret-1");
    expect(detail.json.redactedHeaders["content-type"]).toBe("application/json");
    expect(JSON.stringify(detail.json)).not.toContain("header-secret-2");
    expect(detail.json).not.toHaveProperty("rawBodyBytes");

    const formDetail = await app.request("GET", `/inbound-events/${form.id}`);
    expect(formDetail.json.bodyPreview).toContain("PAID");
    expect(formDetail.json.bodyPreview).not.toContain("sig-secret-3");

    expect((await app.request("GET", `/inbound-events/${randomUUID()}`)).json.code).toBe("INBOUND_EVENT_NOT_FOUND");
    app.setPrincipal(makePrincipal(userId, ["merchant:read"]));
    expect((await app.request("GET", `/inbound-events/${event.id}`)).status).toBe(403);
    expect((await app.request("GET", "/inbound-events")).status).toBe(403);
    app.setPrincipal(operator());
  });
});

describe.skipIf(!dbAvailable)("gateway route health", () => {
  test("returns per-route samples, daily volume and 24h summary; 404 and 403 paths", async () => {
    const attempt = await makeAttempt();
    const { gatewayId, routeId } = await routeOf(attempt);
    const now = Date.now();
    await createRow("gateway_health_samples", {
      route_id: routeId, window_start: new Date(now - 10 * 60_000),
      successes: 90, definitive_failures: 5, ambiguous_unknowns: 5, rate_limits_429: 2, p50_ms: 100, p95_ms: 400, p99_ms: 900,
    });
    await createRow("gateway_health_samples", {
      route_id: routeId, window_start: new Date(now - 5 * 60_000),
      successes: 0, definitive_failures: 0, ambiguous_unknowns: 0, rate_limits_429: 0,
    });
    await createRow("gateway_health_samples", {
      route_id: routeId, window_start: new Date(now - 3 * 24 * 3600_000),
      successes: 1, definitive_failures: 9, ambiguous_unknowns: 0, p95_ms: 9999,
    });
    const today = new Date(now).toISOString().slice(0, 10);
    await createRow("rm_route_daily_volumes", {
      route_id: routeId, day: today, currency: "LYD", attempt_count: 12, success_count: 10, volume_amount: "1234.5000",
    });

    const result = await app.request("GET", `/gateways/${gatewayId}/health`);
    expect(result.status).toBe(200);
    expect(result.json.routes).toHaveLength(1);
    const route = result.json.routes[0];
    expect(route.routeId).toBe(routeId);
    expect(typeof route.railCode).toBe("string");
    expect(route.samples).toHaveLength(3);
    // Oldest first (chronological), the last one is the empty window.
    expect(route.samples[0].successRate).toBeCloseTo(0.1, 5);
    expect(route.samples[1]).toMatchObject({ successes: 90, p95Ms: 400, successRate: 0.9 });
    expect(route.samples[2].successRate).toBeNull();
    expect(route.dailyVolume).toEqual([{ day: today, currency: "LYD", attemptCount: 12, successCount: 10, volumeAmount: "1234.5000" }]);
    // Only the two samples of the last 24h count; the 3 day old sample is excluded.
    expect(result.json.summary.successRate24h).toBeCloseTo(0.9, 5);
    expect(result.json.summary.p95Ms24h).toBe(400);

    expect((await app.request("GET", `/gateways/${randomUUID()}/health`)).json.code).toBe("GATEWAY_NOT_FOUND");
    app.setPrincipal(makePrincipal(userId, ["attempt:read"]));
    expect((await app.request("GET", `/gateways/${gatewayId}/health`)).status).toBe(403);
    app.setPrincipal(operator());
  });
});
