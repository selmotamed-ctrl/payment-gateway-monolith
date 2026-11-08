import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { client } from "../../prisma/client";
import { adminSystemRouter } from "../../api/internal/adminSystem";
import { auditRows, createStaffUser, dbAvailable, makePrincipal, startApp, uid, type TestApp, purgeSince } from "./harness";

let app: TestApp;
let userId: string;
const monitor = () => makePrincipal(userId, ["security:read"], "SECURITY_ADMIN");
const operatorWrite = () => makePrincipal(userId, ["security:read", "security:write"], "SECURITY_ADMIN");
const settingsWrite = () => makePrincipal(userId, ["settings:read", "settings:write"], "SECURITY_ADMIN");

type Row = Record<string, any>;
const REASON = "retry after the provider outage";

if (dbAvailable) beforeAll(async () => {
  userId = await createStaffUser();
  app = await startApp([adminSystemRouter]);
});
if (dbAvailable) beforeEach(() => app.setPrincipal(operatorWrite()));
const startedAt = new Date(Date.now() - 2000);
if (dbAvailable) afterAll(async () => {
  // Leave no queued job / unpublished outbox event / unshipped audit row for the worker suites.
  await purgeSince(startedAt, ["outbox_events", "audit_outbox", "background_jobs", "notifications", "notification_templates"]);
  await app.close();
  await client.$disconnect();
});

const makeJob = (overrides: Row = {}) =>
  client.backgroundJob.create({
    data: {
      jobType: "RECONCILIATION_RUN",
      referenceType: "STATEMENT",
      referenceId: uid("job-ref"),
      payloadJson: { secretPayload: "JOB-PAYLOAD-MARKER" },
      state: "FAILED",
      attempts: 5,
      maxAttempts: 5,
      lastError: "boom",
      completedAt: new Date(),
      ...overrides,
    } as never,
  });

const makeNotification = (overrides: Row = {}) =>
  client.notification.create({
    data: {
      eventId: uid("evt"),
      addressMasked: "+218***1234",
      addressCiphertext: "ADDRESS-CIPHERTEXT-MARKER",
      templateCode: uid("TPL").toUpperCase(),
      channel: "SMS",
      lang: "EN",
      payloadJson: { code: "PAYLOAD-OTP-MARKER" },
      status: "FAILED",
      attempts: 8,
      ...overrides,
    } as never,
  });

describe.skipIf(!dbAvailable)("jobs and outbox monitors", () => {
  test("summary reflects queued/failed work", async () => {
    const before = (await app.request("GET", "/system/jobs-outbox/summary")).json;
    await makeJob({ state: "FAILED" });
    await makeJob({ state: "QUEUED", attempts: 0, completedAt: null });
    await client.outboxEvent.create({ data: { topic: "t.summary", aggregateType: "X", aggregateId: "1", payloadJson: {} } });
    await client.auditOutbox.create({
      data: { actorId: userId, role: "SECURITY_ADMIN", action: "SUMMARY_TEST", entityType: "X", entityId: "1", beforeJson: {}, afterJson: {} },
    });
    await makeNotification();
    const after = (await app.request("GET", "/system/jobs-outbox/summary")).json;
    expect(after.jobs24h.failed - before.jobs24h.failed).toBe(1);
    expect(after.jobs24h.queued - before.jobs24h.queued).toBe(1);
    expect(after.unpublishedOutbox - before.unpublishedOutbox).toBe(1);
    expect(after.auditOutboxQueued - before.auditOutboxQueued).toBe(1);
    expect(after.failedNotifications - before.failedNotifications).toBe(1);
    expect(after.oldestUnpublishedOutboxAt).not.toBeNull();
    expect(after.oldestAuditOutboxAt).not.toBeNull();
    app.setPrincipal(makePrincipal(userId, ["finance:read"]));
    expect((await app.request("GET", "/system/jobs-outbox/summary")).status).toBe(403);
  });

  test("jobs list filters and never exposes the payload", async () => {
    const failed = await makeJob({ jobType: "ADJUSTMENT_EXECUTION" });
    const queued = await makeJob({ state: "QUEUED", attempts: 0, completedAt: null });
    const list = await app.request("GET", `/system/jobs?state=FAILED&jobType=ADJUSTMENT_EXECUTION&search=${failed.referenceId}`);
    expect(list.status).toBe(200);
    expect(list.json.jobs.map((j: Row) => j.id)).toEqual([failed.id]);
    expect(list.json.jobs[0]).toMatchObject({ state: "FAILED", jobType: "ADJUSTMENT_EXECUTION", lastError: "boom", attempts: 5, maxAttempts: 5 });
    expect(JSON.stringify(list.json)).not.toContain("JOB-PAYLOAD-MARKER");
    const queuedOnly = await app.request("GET", `/system/jobs?state=QUEUED&search=${queued.referenceId}`);
    expect(queuedOnly.json.jobs.map((j: Row) => j.id)).toEqual([queued.id]);
    expect((await app.request("GET", "/system/jobs?state=NOPE")).status).toBe(400);
  });

  test("requeue: FAILED -> QUEUED with a fresh retry budget, audited with the reason", async () => {
    const job = await makeJob();
    const done = await app.request("POST", `/system/jobs/${job.id}/requeue`, { reason: REASON });
    expect(done.status).toBe(200);
    expect(done.json.job).toMatchObject({ id: job.id, state: "QUEUED", attempts: 0, lockedAt: null, completedAt: null });
    const row = await client.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.state).toBe("QUEUED");
    expect(row.availableAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const audits = await auditRows("BACKGROUND_JOB_REQUEUED", job.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(userId);
    expect(audits[0]!.beforeJson).toMatchObject({ state: "FAILED", attempts: 5 });
    expect(audits[0]!.afterJson).toMatchObject({ state: "QUEUED", reason: REASON });

    const again = await app.request("POST", `/system/jobs/${job.id}/requeue`, { reason: REASON });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("JOB_NOT_FAILED");
    expect(await auditRows("BACKGROUND_JOB_REQUEUED", job.id)).toHaveLength(1);
  });

  test("requeue: validation, 404 and authority", async () => {
    const job = await makeJob();
    expect((await app.request("POST", `/system/jobs/${job.id}/requeue`, { reason: "short" })).status).toBe(400);
    expect((await app.request("POST", `/system/jobs/${job.id}/requeue`, {})).status).toBe(400);
    expect((await app.request("POST", `/system/jobs/${randomUUID()}/requeue`, { reason: REASON })).json.code).toBe("BACKGROUND_JOB_NOT_FOUND");
    app.setPrincipal(monitor());
    expect((await app.request("POST", `/system/jobs/${job.id}/requeue`, { reason: REASON })).status).toBe(403);
    expect((await client.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe("FAILED");
  });

  test("a RUNNING job is not requeued", async () => {
    const job = await makeJob({ state: "RUNNING", lockedAt: new Date(), completedAt: null });
    const refused = await app.request("POST", `/system/jobs/${job.id}/requeue`, { reason: REASON });
    expect(refused.status).toBe(409);
    expect(refused.json.details.state).toBe("RUNNING");
  });

  test("outbox monitor: published filter, string ids, no payload, and there is no retry endpoint", async () => {
    const topic = uid("topic");
    const pending = await client.outboxEvent.create({ data: { topic, aggregateType: "Payment", aggregateId: "a1", payloadJson: { pii: "OUTBOX-PAYLOAD-MARKER" } } });
    const sent = await client.outboxEvent.create({ data: { topic, aggregateType: "Payment", aggregateId: "a2", payloadJson: {}, processedAt: new Date() } });
    app.setPrincipal(monitor());
    const unpublished = await app.request("GET", `/system/outbox?topic=${topic}&published=false`);
    expect(unpublished.status).toBe(200);
    expect(unpublished.json.outbox.map((e: Row) => e.id)).toEqual([pending.id.toString()]);
    expect(typeof unpublished.json.outbox[0].id).toBe("string");
    expect(unpublished.json.outbox[0]).toMatchObject({ published: false, aggregateType: "Payment", processedAt: null });
    expect(unpublished.json.outbox[0].ageSeconds).toBeGreaterThanOrEqual(0);
    const published = await app.request("GET", `/system/outbox?topic=${topic}&published=true`);
    expect(published.json.outbox.map((e: Row) => e.id)).toEqual([sent.id.toString()]);
    const all = await app.request("GET", `/system/outbox?topic=${topic}&aggregateType=Payment`);
    expect(all.json.total).toBe(2);
    expect(JSON.stringify(all.json)).not.toContain("OUTBOX-PAYLOAD-MARKER");
    expect((await app.request("GET", "/system/outbox?published=maybe")).status).toBe(400);
    expect((await app.request("POST", `/system/outbox/${pending.id}/retry`, { reason: REASON })).status).toBe(404);
  });

  test("audit outbox monitor: shipped filter without before/after payloads", async () => {
    const action = uid("AUDIT_MON").toUpperCase();
    const queued = await client.auditOutbox.create({
      data: { actorId: userId, role: "SECURITY_ADMIN", action, entityType: "X", entityId: "q", beforeJson: { s: "AUDIT-BEFORE-MARKER" }, afterJson: {}, actorEmail: "a@b.c" },
    });
    const shipped = await client.auditOutbox.create({
      data: { actorId: userId, role: "SECURITY_ADMIN", action, entityType: "X", entityId: "s", beforeJson: {}, afterJson: {}, shippedAt: new Date() },
    });
    app.setPrincipal(monitor());
    const q = await app.request("GET", `/system/audit-outbox?action=${action}&shipped=false`);
    expect(q.json.auditOutbox.map((r: Row) => r.id)).toEqual([queued.id]);
    expect(q.json.auditOutbox[0]).toMatchObject({ shipped: false, shippedAt: null });
    const s = await app.request("GET", `/system/audit-outbox?action=${action}&shipped=true`);
    expect(s.json.auditOutbox.map((r: Row) => r.id)).toEqual([shipped.id]);
    const all = await app.request("GET", `/system/audit-outbox?action=${action}`);
    expect(JSON.stringify(all.json)).not.toContain("AUDIT-BEFORE-MARKER");
    expect(JSON.stringify(all.json)).not.toContain("a@b.c");
    app.setPrincipal(makePrincipal(userId, ["settings:read"]));
    expect((await app.request("GET", "/system/audit-outbox")).status).toBe(403);
  });
});

describe.skipIf(!dbAvailable)("notifications", () => {
  test("defaults to FAILED, supports filters, never returns the ciphertext or payload", async () => {
    const failed = await makeNotification({ channel: "EMAIL" });
    const sent = await makeNotification({ status: "SENT", attempts: 1 });
    const list = await app.request("GET", `/system/notifications?search=${failed.templateCode}`);
    expect(list.status).toBe(200);
    expect(list.json.notifications.map((n: Row) => n.id)).toEqual([failed.id]);
    expect(list.json.notifications[0]).toMatchObject({ status: "FAILED", channel: "EMAIL", addressMasked: "+218***1234" });
    const sentDefault = await app.request("GET", `/system/notifications?search=${sent.templateCode}`);
    expect(sentDefault.json.notifications).toEqual([]);
    const explicit = await app.request("GET", `/system/notifications?status=SENT&search=${sent.templateCode}`);
    expect(explicit.json.notifications.map((n: Row) => n.id)).toEqual([sent.id]);
    const everything = await app.request("GET", `/system/notifications?status=ALL&channel=SMS&search=${sent.templateCode}`);
    expect(everything.json.notifications.map((n: Row) => n.id)).toEqual([sent.id]);
    const serialized = JSON.stringify([list.json, explicit.json, everything.json]);
    expect(serialized).not.toContain("ADDRESS-CIPHERTEXT-MARKER");
    expect(serialized).not.toContain("addressCiphertext");
    expect(serialized).not.toContain("PAYLOAD-OTP-MARKER");
    expect((await app.request("GET", "/system/notifications?channel=FAX")).status).toBe(400);
  });

  test("retry: FAILED -> QUEUED, audited; second retry and non-failed rows are 409", async () => {
    const failed = await makeNotification();
    const done = await app.request("POST", `/system/notifications/${failed.id}/retry`, { reason: REASON });
    expect(done.status).toBe(200);
    expect(done.json.notification).toMatchObject({ id: failed.id, status: "QUEUED", attempts: 0 });
    expect(JSON.stringify(done.json)).not.toContain("ADDRESS-CIPHERTEXT-MARKER");
    const row = await client.notification.findUniqueOrThrow({ where: { id: failed.id } });
    expect(row.status).toBe("QUEUED");
    expect(row.nextAttemptAt).not.toBeNull();
    const audits = await auditRows("NOTIFICATION_RETRY_REQUESTED", failed.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.beforeJson).toMatchObject({ status: "FAILED", attempts: 8 });
    expect(audits[0]!.afterJson).toMatchObject({ status: "QUEUED", reason: REASON });

    const again = await app.request("POST", `/system/notifications/${failed.id}/retry`, { reason: REASON });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("NOTIFICATION_NOT_FAILED");
    const delivered = await makeNotification({ status: "DELIVERED" });
    expect((await app.request("POST", `/system/notifications/${delivered.id}/retry`, { reason: REASON })).status).toBe(409);
  });

  test("retry: validation, 404 and authority", async () => {
    const failed = await makeNotification();
    expect((await app.request("POST", `/system/notifications/${failed.id}/retry`, { reason: "nope" })).status).toBe(400);
    expect((await app.request("POST", `/system/notifications/${randomUUID()}/retry`, { reason: REASON })).json.code).toBe("NOTIFICATION_NOT_FOUND");
    app.setPrincipal(monitor());
    expect((await app.request("POST", `/system/notifications/${failed.id}/retry`, { reason: REASON })).status).toBe(403);
    expect((await client.notification.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("FAILED");
  });
});

describe.skipIf(!dbAvailable)("notification templates", () => {
  const makeTemplates = async () => {
    const code = uid("TPL_CODE").toUpperCase().replaceAll("-", "_");
    const en = await client.notificationTemplate.create({
      data: { code, channel: "EMAIL", lang: "EN", subjectTemplate: "Payment {{amount}}", bodyTemplate: "Hello {{name}}, you paid {{amount}}", confidentialityClass: "MERCHANT" },
    });
    const ar = await client.notificationTemplate.create({
      data: { code, channel: "EMAIL", lang: "AR", subjectTemplate: null, bodyTemplate: "مرحبا {{name}} {{amount}} {{currency}}", confidentialityClass: "MERCHANT" },
    });
    return { code, en, ar };
  };

  test("a new version supersedes the old one in a single step and is audited", async () => {
    const { code, en } = await makeTemplates();
    app.setPrincipal(settingsWrite());
    const updated = await app.request("PUT", `/settings/notification-templates/${en.id}`, {
      bodyTemplate: "Dear {{name}}, {{amount}} {{currency}} received",
    });
    expect(updated.status).toBe(200);
    expect(updated.json.template).toMatchObject({ code, channel: "EMAIL", lang: "EN", version: 2, active: true });
    expect(updated.json.template.id).not.toBe(en.id);
    expect(updated.json.template.subjectTemplate).toBe("Payment {{amount}}");
    expect(updated.json.template.variables.sort()).toEqual(["amount", "currency", "name"]);
    expect(updated.json.previous).toMatchObject({ id: en.id, version: 1, active: false });

    const rows = await client.notificationTemplate.findMany({ where: { code, channel: "EMAIL", lang: "EN" }, orderBy: { version: "asc" } });
    expect(rows.map((r) => [r.version, r.active])).toEqual([[1, false], [2, true]]);
    expect(rows[0]!.bodyTemplate).toBe("Hello {{name}}, you paid {{amount}}");

    const audits = await auditRows("NOTIFICATION_TEMPLATE_VERSIONED", updated.json.template.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.beforeJson).toMatchObject({ id: en.id, version: 1 });
    expect(audits[0]!.afterJson).toMatchObject({ version: 2 });

    // The old version can no longer be edited; the new one can, and becomes v3.
    const stale = await app.request("PUT", `/settings/notification-templates/${en.id}`, { bodyTemplate: "x {{name}}" });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("TEMPLATE_VERSION_NOT_ACTIVE");
    const third = await app.request("PUT", `/settings/notification-templates/${updated.json.template.id}`, {
      subjectTemplate: null,
      bodyTemplate: "Third {{name}}",
      confidentialityClass: "PUBLIC",
    });
    expect(third.status).toBe(200);
    expect(third.json.template).toMatchObject({ version: 3, subjectTemplate: null, confidentialityClass: "PUBLIC" });

    // Default listing: latest active only. History: every version.
    const latest = await app.request("GET", `/settings/notification-templates?code=${code}`);
    expect(latest.json.templates.map((t: Row) => [t.lang, t.version, t.active]).sort()).toEqual([["AR", 1, true], ["EN", 3, true]]);
    const history = await app.request("GET", `/settings/notification-templates?code=${code}&history=true&lang=EN`);
    expect(history.json.templates.map((t: Row) => [t.version, t.active])).toEqual([[3, true], [2, false], [1, false]]);
    const inactive = await app.request("GET", `/settings/notification-templates?code=${code}&history=true&active=false`);
    expect(inactive.json.templates.map((t: Row) => t.version).sort()).toEqual([1, 2]);
  });

  test("unknown placeholders are 422 with the list; nothing changes", async () => {
    const { code, en } = await makeTemplates();
    app.setPrincipal(settingsWrite());
    const refused = await app.request("PUT", `/settings/notification-templates/${en.id}`, {
      bodyTemplate: "Hello {{name}} {{secretField}} {{ other_thing }}",
    });
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe("TEMPLATE_UNKNOWN_PLACEHOLDERS");
    expect(refused.json.details.unknown).toEqual(["other_thing", "secretField"]);
    expect(refused.json.details.allowed).toEqual(["amount", "currency", "name"]);
    const rows = await client.notificationTemplate.findMany({ where: { code } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.version === 1 && r.active)).toBe(true);
    expect(await client.auditLog.count({ where: { action: "NOTIFICATION_TEMPLATE_VERSIONED", entityType: "NOTIFICATION_TEMPLATE", afterJson: { path: ["code"], equals: code } } })).toBe(0);
  });

  test("identical content, empty body, unknown id and missing authority are refused", async () => {
    const { en } = await makeTemplates();
    app.setPrincipal(settingsWrite());
    const same = await app.request("PUT", `/settings/notification-templates/${en.id}`, { bodyTemplate: en.bodyTemplate });
    expect(same.status).toBe(409);
    expect(same.json.code).toBe("TEMPLATE_UNCHANGED");
    expect((await app.request("PUT", `/settings/notification-templates/${en.id}`, { bodyTemplate: "  " })).status).toBe(400);
    expect((await app.request("PUT", `/settings/notification-templates/${en.id}`, { bodyTemplate: "ok", confidentialityClass: "SECRET" })).status).toBe(400);
    expect((await app.request("PUT", `/settings/notification-templates/${randomUUID()}`, { bodyTemplate: "ok" })).json.code).toBe("NOTIFICATION_TEMPLATE_NOT_FOUND");
    app.setPrincipal(makePrincipal(userId, ["settings:read"]));
    expect((await app.request("PUT", `/settings/notification-templates/${en.id}`, { bodyTemplate: "Hi {{name}}" })).status).toBe(403);
    app.setPrincipal(makePrincipal(userId, ["security:read"]));
    expect((await app.request("GET", "/settings/notification-templates")).status).toBe(403);
    expect((await client.notificationTemplate.findUniqueOrThrow({ where: { id: en.id } })).active).toBe(true);
  });
});
