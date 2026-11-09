/**
 * AUTO-34 against live PostgreSQL: the outbox fan-out, the delivery worker (signing, retry schedule, parking, disabling,
 * rotation overlap, node concurrency) and the merchant-facing endpoint service (scoping, secret handling, redeliver).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createFakeRepositories } from "../helpers/fakeRepositories";
import { Vault } from "../../engine/crypto/Vault";
import { createWebhookFanout } from "../../engine/webhooks/fanout";
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS, webhookEventTypeOf } from "../../engine/webhooks/events";
import { WEBHOOK_SECRET_KEY_ID, WebhookEndpointService } from "../../engine/webhooks/WebhookEndpointService";
import { MerchantWebhookWorker } from "../../engine/workers/MerchantWebhookWorker";
import { WebhookEgressError, type PinnedPostInput, type PinnedPostResult } from "../../lib/webhooks/egress";
import { verifyWebhook } from "../../lib/webhooks/standardWebhooks";
import type { OutboxEnvelope } from "../../lib/storageEngine/ports";
import { cleanupAutomationCatalog, createAutomationCatalog, type AutomationCatalog } from "../helpers/automationCatalog";
import { createPrisma, databaseIsReachable } from "../storage-engine/helpers/db";

const client = createPrisma({ max: 10 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const vault = new Vault({ masterKey: randomBytes(32) });
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const catalogs: AutomationCatalog[] = [];
const DAY = 86_400_000;
const actor = { userId: null as string | null, role: "MERCHANT_ADMIN" };

afterAll(async () => {
  for (const catalog of catalogs) {
    await client.$executeRawUnsafe(`DELETE FROM merchant_webhook_endpoints WHERE merchant_id = $1::uuid`, catalog.merchantId); // deliveries cascade
  }
  await cleanupAutomationCatalog(client, catalogs);
  await client.$disconnect();
});

const setup = async () => {
  const catalog = await createAutomationCatalog(client, { label: "webhook" });
  catalogs.push(catalog);
  actor.userId = catalog.userId;
  return catalog;
};

const service = (extra: Partial<ConstructorParameters<typeof WebhookEndpointService>[0]> = {}) =>
  new WebhookEndpointService({
    db: client as never,
    vault,
    resolver: async () => ["93.184.216.34"],
    ...extra,
  });

const endpoint = async (catalog: AutomationCatalog, options: { url?: string; eventTypes?: string[] } = {}) => {
  const created = await service().create({
    merchantId: catalog.merchantId,
    applicationId: catalog.applicationId,
    url: options.url ?? `https://hooks.example.ly/${randomUUID().slice(0, 6)}`,
    eventTypes: options.eventTypes,
    actor: { ...actor },
  });
  return created;
};

const deliveriesOf = (endpointId: string) =>
  client.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT id::text AS id, event_id, event_type, status, attempts, next_attempt_at, last_status_code, last_error, park_reason, body, delivered_at FROM merchant_webhook_deliveries WHERE endpoint_id = $1::uuid ORDER BY created_at, id`,
    endpointId,
  );
const endpointRow = async (id: string) => (await client.$queryRawUnsafe<Array<Record<string, any>>>(`SELECT * FROM merchant_webhook_endpoints WHERE id = $1::uuid`, id))[0]!;

const attemptEvent = async (catalog: AutomationCatalog, status: string, outboxId: string): Promise<OutboxEnvelope> => {
  const attempt = await catalog.newAttempt({ status, amount: "125.5000" });
  return {
    id: outboxId,
    topic: "attempt.transitioned",
    aggregateType: "PAYMENT_ATTEMPT",
    aggregateId: attempt.id,
    merchantId: catalog.merchantId,
    payload: { event: "terminal", attemptId: attempt.id, merchantId: catalog.merchantId, status, occurredAt: "2026-11-09T10:00:00.000Z" },
  };
};

describe("event mapping (pure)", () => {
  test("only terminal attempt statuses with a webhook event map; other topics map by name; the rest are not merchant-facing", () => {
    const terminal = (status: string) => webhookEventTypeOf("attempt.transitioned", { event: "terminal", status });
    expect(terminal("SUCCEEDED")).toBe("payment.succeeded");
    expect(terminal("FAILED")).toBe("payment.failed");
    expect(terminal("EXPIRED")).toBe("payment.expired");
    expect(terminal("REFUNDED")).toBe("payment.refunded");
    expect(terminal("CANCELLED")).toBeNull();
    expect(terminal("BLOCKED")).toBeNull(); // a block is a risk decision: never told to the merchant as such
    expect(webhookEventTypeOf("attempt.transitioned", { event: "other", status: "SUCCEEDED" })).toBeNull();
    for (const topic of ["link.expired", "dispute.opened", "dispute.closed", "cashout.paid", "cashout.failed"]) expect(webhookEventTypeOf(topic, {})).toBe(topic as never);
    expect(webhookEventTypeOf("ledger.entry_posted", {})).toBeNull();
    expect(webhookEventTypeOf("merchant.updated", {})).toBeNull();
  });

  test("the retry schedule is 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h (about 27 h) over 8 attempts", () => {
    expect(WEBHOOK_RETRY_DELAYS_MS).toEqual([5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(8);
    expect(WEBHOOK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) / 3_600_000).toBeCloseTo(27.58, 1);
  });
});

describeDb("fan-out (live PostgreSQL)", () => {
  test("a terminal attempt becomes one delivery per matching ACTIVE endpoint of its application, with a merchant-safe body", async () => {
    const catalog = await setup();
    const all = await endpoint(catalog);
    const onlyFailures = await endpoint(catalog, { eventTypes: ["payment.failed"] });
    const succeededOnly = await endpoint(catalog, { eventTypes: ["payment.succeeded", "link.expired"] });
    const disabled = await endpoint(catalog);
    await service().update({ merchantId: catalog.merchantId, endpointId: disabled.endpoint.id, enabled: false, actor });

    const event = await attemptEvent(catalog, "SUCCEEDED", "9000001");
    await createWebhookFanout({ now: () => new Date("2026-11-09T10:00:05.000Z") })([event], client as never);

    expect(await deliveriesOf(all.endpoint.id)).toHaveLength(1);
    expect(await deliveriesOf(succeededOnly.endpoint.id)).toHaveLength(1);
    expect(await deliveriesOf(onlyFailures.endpoint.id)).toHaveLength(0);
    expect(await deliveriesOf(disabled.endpoint.id)).toHaveLength(0);

    const delivery = (await deliveriesOf(all.endpoint.id))[0]!;
    expect(delivery).toMatchObject({ event_id: "evt_9000001", event_type: "payment.succeeded", status: "PENDING", attempts: 0 });
    const body = JSON.parse(delivery.body);
    expect(body).toMatchObject({ id: "evt_9000001", type: "payment.succeeded", created: "2026-11-09T10:00:00.000Z" });
    expect(body.data).toMatchObject({ paymentId: event.aggregateId, status: "SUCCEEDED", currency: expect.any(String) });
    // nothing sensitive: identifiers, status and amounts only
    expect(Object.keys(body.data).sort()).toEqual(["amount", "currency", "linkId", "netAmount", "paymentId", "reference", "status"]);
    expect(delivery.body).not.toMatch(/card|pan|cvv|aml|screening|customer/i);
  });

  test("replaying the same outbox event adds nothing (idempotent per endpoint and event); a new event adds one", async () => {
    const catalog = await setup();
    const { endpoint: ep } = await endpoint(catalog);
    const event = await attemptEvent(catalog, "FAILED", "9000010");
    const fanout = createWebhookFanout();
    await fanout([event], client as never);
    await fanout([event], client as never);
    await Promise.all([fanout([event], client as never), fanout([event], client as never)]);
    expect(await deliveriesOf(ep.id)).toHaveLength(1);
    await fanout([await attemptEvent(catalog, "EXPIRED", "9000011")], client as never);
    expect((await deliveriesOf(ep.id)).map((row) => row.event_type)).toEqual(["payment.failed", "payment.expired"]);
  });

  test("events that are not merchant-facing, and merchants without endpoints, write nothing; another merchant's endpoint is never targeted", async () => {
    const mine = await setup();
    const other = await setup();
    const { endpoint: otherEndpoint } = await endpoint(other);
    const event = await attemptEvent(mine, "SUCCEEDED", "9000020");
    await createWebhookFanout()([event], client as never);
    await createWebhookFanout()([await attemptEvent(mine, "CANCELLED", "9000021")], client as never);
    await createWebhookFanout()([{ id: "9000022", topic: "ledger.entry_posted", aggregateType: "x", aggregateId: "y", payload: {} }], client as never);
    expect(await deliveriesOf(otherEndpoint.id)).toHaveLength(0);
  });

  test("link.expired and the dispute and cash-out events fan out with their own data; merchant-level events reach every endpoint of the merchant", async () => {
    const catalog = await setup();
    const { endpoint: ep } = await endpoint(catalog);
    const second = await endpoint(catalog, { eventTypes: ["cashout.paid"] });
    await createWebhookFanout()(
      [
        { id: "9000030", topic: "link.expired", aggregateType: "payment_link", aggregateId: catalog.linkId, merchantId: catalog.merchantId, payload: { linkId: catalog.linkId, expiredAt: "2026-11-09T10:00:00.000Z" } },
        { id: "9000031", topic: "cashout.paid", aggregateType: "CASHOUT_REQUEST", aggregateId: "c1", merchantId: catalog.merchantId, payload: { cashoutId: "c1", amount: "500.0000", currency: "LYD", occurredAt: "2026-11-09T10:00:00.000Z" } },
        { id: "9000032", topic: "dispute.opened", aggregateType: "DISPUTE", aggregateId: "d1", merchantId: catalog.merchantId, payload: { disputeId: "d1", amount: "20.0000" } },
        { id: "9000033", topic: "dispute.closed", aggregateType: "DISPUTE", aggregateId: "d1" /* no merchant: not deliverable */, payload: { disputeId: "d1" } },
      ],
      client as never,
    );
    const rows = await deliveriesOf(ep.id);
    expect(rows.map((row) => row.event_type).sort()).toEqual(["cashout.paid", "dispute.opened", "link.expired"]);
    const cashout = JSON.parse(rows.find((row) => row.event_type === "cashout.paid")!.body);
    expect(cashout.data).toEqual({ cashoutId: "c1", amount: "500.0000", currency: "LYD" });
    expect(cashout.created).toBe("2026-11-09T10:00:00.000Z");
    expect(JSON.parse(rows.find((row) => row.event_type === "link.expired")!.body).data.linkId).toBe(catalog.linkId);
    expect((await deliveriesOf(second.endpoint.id)).map((row) => row.event_type)).toEqual(["cashout.paid"]);
  });
});

interface Sent { url: string; body: string; headers: Record<string, string> }

describeDb("delivery worker (live PostgreSQL)", () => {
  const setupScoped = async () => {
    const catalog = await setup();
    scope = [catalog.merchantId];
    return catalog;
  };
  // Every worker here is scoped to the merchant of its test: the database is shared with other suites' pending rows.
  let scope: string[] = [];
  const worker = (now: Date, send: (input: PinnedPostInput) => Promise<PinnedPostResult>, extra: Partial<ConstructorParameters<typeof MerchantWebhookWorker>[0]> = {}) =>
    new MerchantWebhookWorker({
      db: client as never,
      repositories: createFakeRepositories(),
      logger: quiet,
      healthRegistry: null,
      clock: () => now,
      openSecret: (ciphertext: string) => vault.decryptSecret(ciphertext),
      send,
      random: () => 0.5, // jitter factor exactly 1
      batchSize: 200,
      merchantIds: scope,
      ...extra,
    } as never);

  const queue = async (catalog: AutomationCatalog, ep: string, at: Date, eventId = `evt_${randomUUID().slice(0, 8)}`) => {
    const id = randomUUID();
    await client.$executeRawUnsafe(
      `INSERT INTO merchant_webhook_deliveries (id, created_at, updated_at, endpoint_id, merchant_id, event_id, event_type, body, status, attempts, next_attempt_at)
       VALUES ($1::uuid, $2, $2, $3::uuid, $4::uuid, $5, 'payment.succeeded', $6, 'PENDING', 0, $2)`,
      id,
      at,
      ep,
      catalog.merchantId,
      eventId,
      JSON.stringify({ id: eventId, type: "payment.succeeded", created: at.toISOString(), data: { paymentId: "p1" } }),
    );
    return id;
  };
  const ok = async (): Promise<PinnedPostResult> => ({ status: 200, latencyMs: 12 });
  const statusOf = (status: number) => async (): Promise<PinnedPostResult> => ({ status, latencyMs: 30 });

  test("a due delivery is sent signed with the endpoint secret and marked DELIVERED; the endpoint records the success", async () => {
    const catalog = await setupScoped();
    const { endpoint: ep, secret } = await endpoint(catalog);
    const at = new Date();
    const deliveryId = await queue(catalog, ep.id, at);
    const sent: Sent[] = [];
    await worker(new Date(at.getTime() + 1000), async (input) => {
      sent.push({ url: input.url, body: input.body, headers: input.headers });
      return { status: 200, latencyMs: 12 };
    }).runOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(ep.url);
    expect(verifyWebhook({ headers: sent[0]!.headers, body: sent[0]!.body, secrets: [secret], now: new Date(at.getTime() + 1000) })).toBe(true);
    const row = (await deliveriesOf(ep.id)).find((d) => d.id === deliveryId)!;
    expect(row).toMatchObject({ status: "DELIVERED", attempts: 1, last_status_code: 200 });
    expect(row.delivered_at).not.toBeNull();
    expect((await endpointRow(ep.id)).last_success_at).not.toBeNull();
    // delivered rows are never sent again
    await worker(new Date(at.getTime() + 2000), async (input) => { sent.push({ url: input.url, body: input.body, headers: input.headers }); return { status: 200, latencyMs: 1 }; }).runOnce();
    expect(sent).toHaveLength(1);
  });

  test("failures retry on the exact schedule (5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h) and the 8th failed attempt parks the delivery", async () => {
    const catalog = await setupScoped();
    const { endpoint: ep } = await endpoint(catalog);
    const start = new Date();
    const id = await queue(catalog, ep.id, start);
    let clock = new Date(start.getTime() + 1000);
    const observed: number[] = [];
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      await worker(clock, statusOf(503)).runOnce();
      const row = (await deliveriesOf(ep.id)).find((d) => d.id === id)!;
      expect(row.attempts).toBe(attempt);
      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        expect(row.status).toBe("PENDING");
        observed.push(new Date(row.next_attempt_at).getTime() - clock.getTime());
        clock = new Date(new Date(row.next_attempt_at).getTime() + 1);
      } else {
        expect(row).toMatchObject({ status: "PARKED", park_reason: "MAX_ATTEMPTS", last_status_code: 503 });
        expect(row.next_attempt_at).toBeNull();
      }
    }
    expect(observed).toEqual([...WEBHOOK_RETRY_DELAYS_MS]);
  });

  test("jitter keeps each delay within +-20 % of the schedule", async () => {
    const catalog = await setupScoped();
    const { endpoint: ep } = await endpoint(catalog);
    const start = new Date();
    const id = await queue(catalog, ep.id, start);
    const clock = new Date(start.getTime() + 1000);
    await worker(clock, statusOf(500), { random: () => 0 }).runOnce(); // factor 0.8
    const row = (await deliveriesOf(ep.id)).find((d) => d.id === id)!;
    expect(new Date(row.next_attempt_at).getTime() - clock.getTime()).toBe(4_000);
  });

  test("429, 408 and network errors retry; any other 4xx, a redirect and an unsafe URL park immediately with the reason", async () => {
    const catalog = await setupScoped();
    const { endpoint: ep } = await endpoint(catalog);
    const at = new Date();
    const cases: Array<[string, () => Promise<PinnedPostResult>, string, string | null]> = [
      ["429", statusOf(429), "PENDING", null],
      ["408", statusOf(408), "PENDING", null],
      ["network", async () => { throw new WebhookEgressError("Connection failed: ECONNRESET", true, "NETWORK"); }, "PENDING", null],
      ["400", statusOf(400), "PARKED", "NOT_RETRYABLE"],
      ["410", statusOf(410), "PARKED", "NOT_RETRYABLE"],
      ["302", statusOf(302), "PARKED", "NOT_RETRYABLE"],
      ["private", async () => { throw new WebhookEgressError("The host resolves to a non-public address", false, "PRIVATE_HOST"); }, "PARKED", "NOT_RETRYABLE"],
    ];
    for (const [label, send, status, reason] of cases) {
      const id = await queue(catalog, ep.id, at, `evt_${label}_${randomUUID().slice(0, 6)}`);
      await worker(new Date(at.getTime() + 1000), send).runOnce();
      const row = (await deliveriesOf(ep.id)).find((d) => d.id === id)!;
      expect(row.status, label).toBe(status);
      expect(row.park_reason, label).toBe(reason);
      expect(row.attempts, label).toBe(1);
    }
    const redirect = (await deliveriesOf(ep.id)).find((d) => d.event_id.startsWith("evt_302_"))!;
    expect(redirect.last_error).toMatch(/redirect/i);
    expect(redirect.last_status_code).toBe(302);
  });

  test("the response body is never stored: only status, latency and a short error", async () => {
    const catalog = await setupScoped();
    const { endpoint: ep } = await endpoint(catalog);
    const at = new Date();
    const id = await queue(catalog, ep.id, at);
    await worker(new Date(at.getTime() + 1000), async () => ({ status: 500, latencyMs: 7, body: "SECRET-STACK-TRACE" }) as never).runOnce();
    const row = (await deliveriesOf(ep.id)).find((d) => d.id === id)!;
    expect(JSON.stringify(row)).not.toContain("SECRET-STACK-TRACE");
    expect(String(row.last_error).length).toBeLessThanOrEqual(300);
  });

  test("during a rotation overlap the request carries two signatures; after it only the new one", async () => {
    const catalog = await setupScoped();
    const { endpoint: ep, secret: first } = await endpoint(catalog);
    const rotated = await service().rotateSecret({ merchantId: catalog.merchantId, endpointId: ep.id, actor });
    expect(rotated.endpoint.rotationOverlapActive).toBe(true);
    const at = new Date();
    const id = await queue(catalog, ep.id, at);
    const sent: Sent[] = [];
    const capture = async (input: PinnedPostInput): Promise<PinnedPostResult> => {
      sent.push({ url: input.url, body: input.body, headers: input.headers });
      return { status: 200, latencyMs: 1 };
    };
    await worker(new Date(at.getTime() + 1000), capture).runOnce();
    const now = new Date(at.getTime() + 1000);
    expect(sent[0]!.headers["webhook-signature"]!.split(" ")).toHaveLength(2);
    expect(verifyWebhook({ headers: sent[0]!.headers, body: sent[0]!.body, secrets: [first], now })).toBe(true);
    expect(verifyWebhook({ headers: sent[0]!.headers, body: sent[0]!.body, secrets: [rotated.secret], now })).toBe(true);

    // 25 hours later the overlap is over: one signature, and the old secret no longer verifies
    const later = new Date(at.getTime() + 25 * 3_600_000);
    await client.$executeRawUnsafe(`UPDATE merchant_webhook_deliveries SET status = 'PENDING', next_attempt_at = $2, attempts = 0 WHERE id = $1::uuid`, id, later);
    await worker(new Date(later.getTime() + 1000), capture).runOnce();
    expect(sent[1]!.headers["webhook-signature"]!.split(" ")).toHaveLength(1);
    expect(verifyWebhook({ headers: sent[1]!.headers, body: sent[1]!.body, secrets: [first], now: new Date(later.getTime() + 1000) })).toBe(false);
    expect(verifyWebhook({ headers: sent[1]!.headers, body: sent[1]!.body, secrets: [rotated.secret], now: new Date(later.getTime() + 1000) })).toBe(true);
  });

  test("a delivery of a disabled endpoint is parked without a request", async () => {
    const catalog = await setupScoped();
    const { endpoint: ep } = await endpoint(catalog);
    const at = new Date();
    const id = await queue(catalog, ep.id, at);
    await client.$executeRawUnsafe(`UPDATE merchant_webhook_endpoints SET status = 'DISABLED' WHERE id = $1::uuid`, ep.id);
    let calls = 0;
    await worker(new Date(at.getTime() + 1000), async () => { calls += 1; return { status: 200, latencyMs: 1 }; }).runOnce();
    expect(calls).toBe(0);
    expect((await deliveriesOf(ep.id)).find((d) => d.id === id)).toMatchObject({ status: "PARKED", park_reason: "ENDPOINT_DISABLED" });
  });

  test("continuous failure for 5 days disables the endpoint, parks its queue, tells the merchant once and audits; a success in between resets the streak", async () => {
    const catalog = await setupScoped();
    const { endpoint: ep } = await endpoint(catalog);
    const day0 = new Date();
    // day 0: the first failure starts the streak
    const first = await queue(catalog, ep.id, day0);
    await worker(new Date(day0.getTime() + 1000), statusOf(500)).runOnce();
    expect((await endpointRow(ep.id)).failing_since).not.toBeNull();
    // day 3: a success clears it
    const second = await queue(catalog, ep.id, new Date(day0.getTime() + 3 * DAY));
    await worker(new Date(day0.getTime() + 3 * DAY + 1000), ok).runOnce();
    expect((await endpointRow(ep.id)).failing_since).toBeNull();
    expect((await deliveriesOf(ep.id)).find((d) => d.id === second)!.status).toBe("DELIVERED");

    // a new streak: 4 days after the success is not enough, 5 days is
    const streakStart = new Date(day0.getTime() + 4 * DAY);
    await queue(catalog, ep.id, streakStart);
    await worker(new Date(streakStart.getTime() + 1000), statusOf(500)).runOnce();
    const waiting = await queue(catalog, ep.id, new Date(streakStart.getTime() + 2 * DAY)); // a queued one that must end up parked
    await worker(new Date(streakStart.getTime() + 4 * DAY + 3_600_000), statusOf(500)).runOnce();
    expect((await endpointRow(ep.id)).status).toBe("ACTIVE");
    await worker(new Date(streakStart.getTime() + 5 * DAY + 3_600_000), statusOf(500)).runOnce();
    const disabled = await endpointRow(ep.id);
    expect(disabled.status).toBe("DISABLED");
    expect(disabled.disabled_reason).toBe("FAILING_FOR_DAYS");
    expect(disabled.disabled_at).not.toBeNull();
    expect((await deliveriesOf(ep.id)).filter((d) => d.status === "PENDING")).toHaveLength(0);
    expect((await deliveriesOf(ep.id)).find((d) => d.id === waiting)!.park_reason).toMatch(/ENDPOINT_DISABLED|MAX_ATTEMPTS|NOT_RETRYABLE/);
    void first;

    const audits = await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'MERCHANT_WEBHOOK_ENDPOINT_DISABLED' AND entity_id = $1`, ep.id);
    expect(Number(audits[0]!.n)).toBe(1);
    const notices = await client.notification.findMany({ where: { templateCode: "MERCHANT_WEBHOOK_DISABLED", recipientMerchantId: catalog.merchantId } });
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((row) => JSON.stringify(row.payloadJson).includes("hooks.example.ly"))).toBe(true);
    expect(JSON.stringify(notices)).not.toContain("whsec_");
  });

  test("several nodes at once send every delivery exactly once", async () => {
    const catalog = await setupScoped();
    const { endpoint: ep } = await endpoint(catalog);
    const at = new Date();
    const ids: string[] = [];
    for (let index = 0; index < 14; index += 1) ids.push(await queue(catalog, ep.id, at));
    const sentIds: string[] = [];
    const send = async (input: PinnedPostInput): Promise<PinnedPostResult> => {
      sentIds.push(JSON.parse(input.body).id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: 200, latencyMs: 5 };
    };
    const now = new Date(at.getTime() + 1000);
    await Promise.all([worker(now, send, { batchSize: 6 }).runOnce(), worker(now, send, { batchSize: 6 }).runOnce(), worker(now, send, { batchSize: 6 }).runOnce()]);
    expect(new Set(sentIds).size).toBe(sentIds.length);
    await worker(now, send, { batchSize: 6 }).runOnce();
    expect(sentIds).toHaveLength(14);
    expect((await deliveriesOf(ep.id)).every((d) => d.status === "DELIVERED" && d.attempts === 1)).toBe(true);
  });

  test("a crashed node's claim is retried after its lease; a live claim is not stolen", async () => {
    const catalog = await setupScoped();
    const { endpoint: ep } = await endpoint(catalog);
    const at = new Date();
    const id = await queue(catalog, ep.id, at);
    await client.$executeRawUnsafe(`UPDATE merchant_webhook_deliveries SET attempts = 1, next_attempt_at = $2 WHERE id = $1::uuid`, id, new Date(at.getTime() + 120_000));
    let calls = 0;
    const send = async (): Promise<PinnedPostResult> => { calls += 1; return { status: 200, latencyMs: 1 }; };
    await worker(new Date(at.getTime() + 60_000), send).runOnce();
    expect(calls).toBe(0);
    await worker(new Date(at.getTime() + 121_000), send).runOnce();
    expect(calls).toBe(1);
    expect((await deliveriesOf(ep.id)).find((d) => d.id === id)).toMatchObject({ status: "DELIVERED", attempts: 2 });
  });
});

describeDb("endpoint service (live PostgreSQL)", () => {
  test("create returns the secret ONCE; the database holds only vault ciphertext; the view never shows it", async () => {
    const catalog = await setup();
    const { endpoint: ep, secret } = await endpoint(catalog, { eventTypes: ["payment.succeeded"] });
    expect(secret.startsWith("whsec_")).toBe(true);
    const row = await endpointRow(ep.id);
    expect(row.secret_ciphertext).not.toContain(secret);
    expect(row.secret_ciphertext.startsWith(`${WEBHOOK_SECRET_KEY_ID}:`)).toBe(true);
    expect(await vault.decryptSecret(row.secret_ciphertext)).toBe(secret);
    expect(JSON.stringify(ep)).not.toContain(secret);
    expect(JSON.stringify(await service().list(catalog.merchantId))).not.toContain("secret_ciphertext");
    expect(ep).toMatchObject({ status: "ACTIVE", eventTypes: ["payment.succeeded"], rotationOverlapActive: false });
  });

  test("URLs and event types are validated; the per-application limit holds; other merchants' applications do not exist", async () => {
    const catalog = await setup();
    const base = { merchantId: catalog.merchantId, applicationId: catalog.applicationId, actor };
    await expect(service().create({ ...base, url: "http://hooks.example.ly/x" })).rejects.toMatchObject({ statusCode: 422, code: "WEBHOOK_INSECURE_URL" });
    await expect(service().create({ ...base, url: "https://10.0.0.5/x" })).rejects.toMatchObject({ code: "WEBHOOK_PRIVATE_HOST" });
    await expect(service({ resolver: async () => ["10.0.0.9"] }).create({ ...base, url: "https://rebind.example.ly/x" })).rejects.toMatchObject({ code: "WEBHOOK_PRIVATE_HOST" });
    await expect(service().create({ ...base, url: "https://hooks.example.ly/x", eventTypes: ["payment.succeeded", "payment.exploded"] })).rejects.toMatchObject({ code: "WEBHOOK_EVENT_TYPE_UNKNOWN" });
    // a name that does not resolve yet is accepted (delivery retries)
    await service({ resolver: async () => { throw new Error("ENOTFOUND"); } }).create({ ...base, url: "https://not-yet.example.ly/x", actor });
    for (let index = 0; index < 4; index += 1) await service().create({ ...base, url: `https://hooks.example.ly/${index}` });
    await expect(service().create({ ...base, url: "https://hooks.example.ly/over" })).rejects.toMatchObject({ statusCode: 409, code: "WEBHOOK_ENDPOINT_LIMIT" });
    const stranger = await setup();
    await expect(service().create({ merchantId: stranger.merchantId, applicationId: catalog.applicationId, url: "https://hooks.example.ly/s", actor })).rejects.toMatchObject({ statusCode: 404 });
  });

  test("an endpoint, its secret and its deliveries are invisible to another merchant", async () => {
    const mine = await setup();
    const theirs = await setup();
    const { endpoint: ep } = await endpoint(mine);
    const delivery = await service().sendTest({ merchantId: mine.merchantId, endpointId: ep.id, actor });
    await expect(service().update({ merchantId: theirs.merchantId, endpointId: ep.id, enabled: false, actor })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service().rotateSecret({ merchantId: theirs.merchantId, endpointId: ep.id, actor })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service().sendTest({ merchantId: theirs.merchantId, endpointId: ep.id, actor })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service().redeliver({ merchantId: theirs.merchantId, deliveryId: delivery.deliveryId, actor })).rejects.toMatchObject({ statusCode: 404 });
    expect(await service().list(theirs.merchantId)).toEqual([]);
    expect(await service().listDeliveries({ merchantId: theirs.merchantId })).toEqual([]);
    expect(await service().listDeliveries({ merchantId: mine.merchantId })).toHaveLength(1);
  });

  test("disabling parks the queue; enabling clears the failure streak; redeliver needs an active endpoint and restarts the attempt cycle", async () => {
    const catalog = await setup();
    const { endpoint: ep } = await endpoint(catalog);
    const test = await service().sendTest({ merchantId: catalog.merchantId, endpointId: ep.id, actor });
    await service().update({ merchantId: catalog.merchantId, endpointId: ep.id, enabled: false, actor });
    expect((await deliveriesOf(ep.id))[0]).toMatchObject({ status: "PARKED", park_reason: "ENDPOINT_DISABLED" });
    await expect(service().redeliver({ merchantId: catalog.merchantId, deliveryId: test.deliveryId, actor })).rejects.toMatchObject({ code: "WEBHOOK_ENDPOINT_DISABLED" });
    await expect(service().sendTest({ merchantId: catalog.merchantId, endpointId: ep.id, actor })).rejects.toMatchObject({ code: "WEBHOOK_ENDPOINT_DISABLED" });

    await client.$executeRawUnsafe(`UPDATE merchant_webhook_endpoints SET failing_since = now() WHERE id = $1::uuid`, ep.id);
    const enabled = await service().update({ merchantId: catalog.merchantId, endpointId: ep.id, enabled: true, actor });
    expect(enabled).toMatchObject({ status: "ACTIVE", disabledReason: null, failingSince: null });

    const result = await service().redeliver({ merchantId: catalog.merchantId, deliveryId: test.deliveryId, actor });
    expect(result.status).toBe("PENDING");
    expect((await deliveriesOf(ep.id))[0]).toMatchObject({ status: "PENDING", attempts: 0, park_reason: null });
    await expect(service().redeliver({ merchantId: catalog.merchantId, deliveryId: test.deliveryId, actor })).rejects.toMatchObject({ code: "WEBHOOK_DELIVERY_PENDING" });
  });

  test("the test event is always delivered whatever the filter, and carries a stable id", async () => {
    const catalog = await setup();
    const { endpoint: ep } = await endpoint(catalog, { eventTypes: ["cashout.paid"] });
    const sent = await service().sendTest({ merchantId: catalog.merchantId, endpointId: ep.id, actor });
    const row = (await deliveriesOf(ep.id))[0]!;
    expect(row).toMatchObject({ event_type: "webhook.test", status: "PENDING", event_id: sent.eventId });
    expect(JSON.parse(row.body)).toMatchObject({ id: sent.eventId, type: "webhook.test" });
  });

  test("listing deliveries filters by status and endpoint and pages by creation time", async () => {
    const catalog = await setup();
    const { endpoint: ep } = await endpoint(catalog);
    for (let index = 0; index < 3; index += 1) await service().sendTest({ merchantId: catalog.merchantId, endpointId: ep.id, actor });
    const all = await service().listDeliveries({ merchantId: catalog.merchantId, endpointId: ep.id });
    expect(all).toHaveLength(3);
    expect(await service().listDeliveries({ merchantId: catalog.merchantId, status: "PARKED" })).toEqual([]);
    const page = await service().listDeliveries({ merchantId: catalog.merchantId, limit: 2 });
    expect(page).toHaveLength(2);
    const next = await service().listDeliveries({ merchantId: catalog.merchantId, before: String(page.at(-1)!.createdAt) });
    expect(next.length).toBeLessThanOrEqual(1);
  });

  test("every management action is audited without the secret", async () => {
    const catalog = await setup();
    const { endpoint: ep, secret } = await endpoint(catalog);
    await service().rotateSecret({ merchantId: catalog.merchantId, endpointId: ep.id, actor });
    const rows = await client.$queryRawUnsafe<Array<{ action: string; after_json: unknown }>>(`SELECT action, after_json FROM audit_log WHERE entity_type = 'MERCHANT_WEBHOOK_ENDPOINT' AND entity_id = $1 ORDER BY created_at`, ep.id);
    expect(rows.map((row) => row.action)).toEqual(["MERCHANT_WEBHOOK_ENDPOINT_CREATED", "MERCHANT_WEBHOOK_SECRET_ROTATED"]);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain("whsec_");
  });
});
