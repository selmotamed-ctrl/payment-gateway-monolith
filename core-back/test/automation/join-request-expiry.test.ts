/**
 * AUTO-13 join request expiry follow-through against live PostgreSQL: every expired request gets its audit row and its
 * (neutral) merchant notice in the same transaction as the status change, repeats are idempotent, and a decision that
 * waits for its checker is never expired.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createFakeRepositories } from "../helpers/fakeRepositories";
import { JoinRequestExpiryWorker } from "../../engine/workers/JoinRequestExpiryWorker";
import { cleanupAutomationCatalog, createAutomationCatalog, type AutomationCatalog } from "../helpers/automationCatalog";
import { createPrisma, databaseIsReachable } from "../storage-engine/helpers/db";

const client = createPrisma({ max: 10 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const catalogs: AutomationCatalog[] = [];
const DAY = 86_400_000;
// The REAL clock: a far-future clock would also expire other suites' join requests in the shared database.
const NOW = new Date();
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

afterAll(async () => {
  for (const catalog of catalogs) {
    await client.$executeRawUnsafe(`DELETE FROM join_requests WHERE merchant_id = $1::uuid`, catalog.merchantId);
    await client.$executeRawUnsafe(`DELETE FROM audit_outbox WHERE entity_type = 'JOIN_REQUEST' AND after_json->>'reason' IN ('DRAFT_ABANDONED','REVIEW_OVERDUE')`).catch(() => undefined);
  }
  await cleanupAutomationCatalog(client, catalogs);
  await client.$disconnect();
});

const request = async (catalog: AutomationCatalog, status: string, ageDays: number, slaDueInDays = 5) =>
  (
    await client.joinRequest.create({
      data: {
        merchantId: catalog.merchantId,
        submittedByUserId: catalog.userId,
        status: status as never,
        onboardingChannel: "SELF_SERVICE" as never,
        slaDueAt: new Date(NOW.getTime() + slaDueInDays * DAY),
        createdAt: new Date(NOW.getTime() - ageDays * DAY),
        updatedAt: new Date(NOW.getTime() - ageDays * DAY),
      },
    })
  ).id;

const worker = (overrides: Partial<ConstructorParameters<typeof JoinRequestExpiryWorker>[0]> = {}) =>
  new JoinRequestExpiryWorker({
    db: client as never,
    repositories: createFakeRepositories(),
    logger: quiet,
    healthRegistry: null,
    clock: () => NOW,
    ...overrides,
  });

const auditCount = async (entityId: string): Promise<number> =>
  Number(
    (await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'JOIN_REQUEST_EXPIRED' AND entity_id = $1`, entityId))[0]?.n ?? 0,
  );

describeDb("join request expiry follow-through (live PostgreSQL)", () => {
  test("an abandoned draft expires with one audit row and one notice per channel; repeats change nothing", async () => {
    const catalog = await createAutomationCatalog(client, { label: "joinreq" });
    catalogs.push(catalog);
    const old = await request(catalog, "DRAFT", 45);
    const recent = await request(catalog, "DRAFT", 3);

    await worker().runOnce();
    expect((await client.joinRequest.findUniqueOrThrow({ where: { id: old } })).status).toBe("EXPIRED");
    expect((await client.joinRequest.findUniqueOrThrow({ where: { id: recent } })).status).toBe("DRAFT");
    expect(await auditCount(old)).toBe(1);
    expect(await auditCount(recent)).toBe(0);

    const notices = await client.notification.findMany({ where: { templateCode: "JOIN_REQUEST_DRAFT_EXPIRED", eventId: { startsWith: `notice:join-request-expired:${old}` } } });
    expect(notices.map((row) => row.channel).sort()).toEqual(["EMAIL", "IN_APP"]);
    expect(notices.every((row) => row.status === "QUEUED" && row.recipientUserId === catalog.userId)).toBe(true);
    expect(notices[0]!.payloadJson).toEqual({ days: 30 });

    await worker().runOnce();
    await worker().runOnce();
    expect(await auditCount(old)).toBe(1);
    expect(await client.notification.count({ where: { eventId: { startsWith: `notice:join-request-expired:${old}` } } })).toBe(2);
    // the neutral templates exist in both languages and channels, merchant class
    const templates = await client.notificationTemplate.findMany({ where: { code: "JOIN_REQUEST_DRAFT_EXPIRED" } });
    expect(templates.map((row) => `${row.channel}/${row.lang}`).sort()).toEqual(["EMAIL/AR", "EMAIL/EN", "IN_APP/AR", "IN_APP/EN"]);
    expect(templates.every((row) => row.confidentialityClass === "MERCHANT")).toBe(true);
    expect(templates.map((row) => row.bodyTemplate).join(" ").toLowerCase()).not.toMatch(/aml|sanction|screening|suspicio|compliance/);
  });

  test("overdue reviews expire with the previous status in the audit row; a decision waiting for its checker is never touched", async () => {
    const catalog = await createAutomationCatalog(client, { label: "joinreq" });
    catalogs.push(catalog);
    const submitted = await request(catalog, "SUBMITTED", 20, -1);
    const inReview = await request(catalog, "IN_REVIEW", 20, -2);
    const info = await request(catalog, "INFO_REQUESTED", 20, -3);
    const onTime = await request(catalog, "IN_REVIEW", 2, 4);
    const pendingChecker = await request(catalog, "PENDING_CHECKER", 20, -9);

    await worker().runOnce();
    for (const id of [submitted, inReview, info]) {
      expect((await client.joinRequest.findUniqueOrThrow({ where: { id } })).status).toBe("EXPIRED");
      expect(await auditCount(id)).toBe(1);
    }
    expect((await client.joinRequest.findUniqueOrThrow({ where: { id: onTime } })).status).toBe("IN_REVIEW");
    expect((await client.joinRequest.findUniqueOrThrow({ where: { id: pendingChecker } })).status).toBe("PENDING_CHECKER");
    const rows = await client.$queryRawUnsafe<Array<{ entity_id: string; before: string }>>(
      `SELECT entity_id, before_json->>'status' AS before FROM audit_log WHERE action = 'JOIN_REQUEST_EXPIRED' AND entity_id = ANY($1::text[])`,
      [submitted, inReview, info],
    );
    expect(Object.fromEntries(rows.map((row) => [row.entity_id, row.before]))).toEqual({
      [submitted]: "SUBMITTED",
      [inReview]: "IN_REVIEW",
      [info]: "INFO_REQUESTED",
    });
    expect(await client.notification.count({ where: { templateCode: "JOIN_REQUEST_REVIEW_EXPIRED", eventId: { in: [submitted, inReview, info].map((id) => `notice:join-request-expired:${id}:IN_APP`) } } })).toBe(3);
  });

  test("work is bounded per batch and continues across batches in one tick", async () => {
    const catalog = await createAutomationCatalog(client, { label: "joinreq" });
    catalogs.push(catalog);
    const ids = await Promise.all(Array.from({ length: 5 }, () => request(catalog, "DRAFT", 60)));
    const w = worker({ batchSize: 2, maxBatchesPerTick: 2 });
    await w.runOnce(); // 2 batches of 2: four of the five
    let expired = (await client.joinRequest.findMany({ where: { id: { in: ids } } })).filter((row) => row.status === "EXPIRED").length;
    expect(expired).toBe(4);
    await w.runOnce();
    expired = (await client.joinRequest.findMany({ where: { id: { in: ids } } })).filter((row) => row.status === "EXPIRED").length;
    expect(expired).toBe(5);
    for (const id of ids) expect(await auditCount(id)).toBe(1);
  });

  test("a failing notice rolls the expiry back: no request is ever expired without its audit row and notice", async () => {
    const catalog = await createAutomationCatalog(client, { label: "joinreq" });
    catalogs.push(catalog);
    const id = await request(catalog, "DRAFT", 60);
    const broken = worker({
      notify: async () => {
        throw new Error("notification outbox unavailable");
      },
    });
    await expect(broken.runOnce()).rejects.toThrow(/notification outbox unavailable/);
    expect((await client.joinRequest.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");
    expect(await auditCount(id)).toBe(0);
    await worker().runOnce();
    expect((await client.joinRequest.findUniqueOrThrow({ where: { id } })).status).toBe("EXPIRED");
    expect(await auditCount(id)).toBe(1);
  });
});
