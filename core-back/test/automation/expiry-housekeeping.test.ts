/**
 * AUTO-05 / AUTO-11 expiry housekeeping against live PostgreSQL: approvals, staff invitations, payment links, MFA
 * challenges, sealed notification secrets and session revocations, plus isolation, bounding and idempotency.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { adminInternalRouter } from "../../api/internal/admin";
import { ExpiryHousekeepingWorker } from "../../engine/workers/ExpiryHousekeepingWorker";
import { cleanupAutomationCatalog, createAutomationCatalog, type AutomationCatalog } from "../helpers/automationCatalog";
import { createFakeRepositories } from "../helpers/fakeRepositories";
import express from "express";
import { signSession } from "../../lib/auth";
import { MemoryAuthStateStore, setAuthStateStore } from "../../lib/auth/sharedState";
import { resetAuthThrottles } from "../../lib/auth/throttle";
import { isApiError, toErrorEnvelope } from "../../lib/error";
import { createPrisma, databaseIsReachable } from "../storage-engine/helpers/db";

const client = createPrisma({ max: 10 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const catalogs: AutomationCatalog[] = [];
// The REAL clock: the database is shared with other suites, and a far-future clock would also expire THEIR rows
// (links, approvals, revocations) and crowd out these tests' rows from the bounded batches.
const NOW = new Date();
const HOUR = 3_600_000;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const created = {
  approvals: [] as string[],
  joinRequests: [] as string[],
  cases: [] as string[],
  users: [] as string[],
  links: [] as string[],
  jtis: [] as string[],
  notifications: [] as string[],
  challenges: [] as string[],
};

afterAll(async () => {
  if (databaseIsReachable) {
    await client.$executeRawUnsafe(`DELETE FROM outbox_events WHERE topic = 'link.expired' AND aggregate_id = ANY($1::text[])`, created.links);
    await client.$executeRawUnsafe(`DELETE FROM notifications WHERE id = ANY($1::uuid[]) OR recipient_user_id = ANY($2::uuid[])`, created.notifications, created.users);
    await client.$executeRawUnsafe(`DELETE FROM mfa_challenges WHERE id = ANY($1::uuid[])`, created.challenges);
    await client.$executeRawUnsafe(`DELETE FROM session_revocations WHERE jti = ANY($1::text[])`, created.jtis);
    await client.$executeRawUnsafe(`DELETE FROM join_requests WHERE id = ANY($1::uuid[])`, created.joinRequests);
    await client.$executeRawUnsafe(`DELETE FROM operator_cases WHERE id = ANY($1::uuid[])`, created.cases);
    await client.$executeRawUnsafe(`DELETE FROM approval_requests WHERE id = ANY($1::uuid[])`, created.approvals);
    await client.$executeRawUnsafe(`DELETE FROM payment_links WHERE id = ANY($1::uuid[])`, created.links);
    await client.$executeRawUnsafe(`DELETE FROM users WHERE id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.actor_id = users.id)`, created.users).catch(() => undefined);
    // Staff are resolved by role elsewhere (the deadline worker): never leave an ACTIVE test checker behind.
    await client.$executeRawUnsafe(`UPDATE users SET status = 'DISABLED' WHERE email LIKE 'hk-%@gateway.test' AND status = 'ACTIVE'`);
    await cleanupAutomationCatalog(client, catalogs);
  }
  await client.$disconnect();
});

const worker = (overrides: Partial<ConstructorParameters<typeof ExpiryHousekeepingWorker>[0]> = {}) =>
  new ExpiryHousekeepingWorker({
    db: client as never,
    repositories: createFakeRepositories(),
    logger: quiet,
    healthRegistry: null,
    clock: () => NOW,
    ...overrides,
  });

const catalogOf = async (): Promise<AutomationCatalog> => {
  const catalog = await createAutomationCatalog(client, { label: "housekeeping" });
  catalogs.push(catalog);
  return catalog;
};

const auditCount = async (action: string, entityId: string): Promise<number> =>
  Number((await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM audit_log WHERE action = $1 AND entity_id = $2`, action, entityId))[0]?.n ?? 0);

const approval = async (
  catalog: AutomationCatalog,
  input: { state: string; expiresInHours: number | null; subjectType?: string; subjectId?: string },
): Promise<string> => {
  const row = await client.approvalRequest.create({
    data: {
      subjectType: input.subjectType ?? "GATEWAY_VERSION",
      subjectId: input.subjectId ?? randomUUID(),
      payloadDiffJson: [{ op: "replace", path: "/x", value: 1 }],
      makerUserId: catalog.userId,
      state: input.state as never,
      expiresAt: input.expiresInHours === null ? null : new Date(NOW.getTime() + input.expiresInHours * HOUR),
    },
  });
  created.approvals.push(row.id);
  return row.id;
};

describeDb("approval requests that nobody decided (AUTO-05)", () => {
  test("only pending approvals past their expiry are closed; the maker is told and the subject is released", async () => {
    const catalog = await catalogOf();
    const stale = await approval(catalog, { state: "PENDING_REVIEW", expiresInHours: -2 });
    const staleDraft = await approval(catalog, { state: "DRAFT", expiresInHours: -30 });
    // An emergency action already in force: its ratification deadline is the DeadlineWorker's (AUTO-22), never silently closed here.
    const emergency = await approval(catalog, { state: "PENDING_REVIEW", expiresInHours: -10 });
    await client.approvalRequest.update({ where: { id: emergency }, data: { mode: "EMERGENCY_RATIFICATION", ratifyDueAt: new Date(NOW.getTime() - 10 * HOUR) } });
    // Subjects with their own lifecycle and money side effects are never closed here (a drafted chargeback keeps its escrow).
    const chargeback = await approval(catalog, { state: "PENDING_REVIEW", expiresInHours: -30, subjectType: "ADJUSTMENT" });
    const cashoutAlias = await approval(catalog, { state: "PENDING_REVIEW", expiresInHours: -30, subjectType: "Cashout Request" });
    const amlCase = await approval(catalog, { state: "PENDING_REVIEW", expiresInHours: -30, subjectType: "aml-case" });
    const future = await approval(catalog, { state: "PENDING_REVIEW", expiresInHours: 5 });
    const noExpiry = await approval(catalog, { state: "PENDING_REVIEW", expiresInHours: null });
    const decided = await Promise.all(["APPROVED", "EXECUTED", "REJECTED"].map((state) => approval(catalog, { state, expiresInHours: -50 })));

    // a join request waiting for its checker, and an operator case waiting for its checker
    const joinApproval = await approval(catalog, { state: "PENDING_REVIEW", expiresInHours: -1, subjectType: "JOIN_REQUEST" });
    const joinRequest = await client.joinRequest.create({
      data: {
        merchantId: catalog.merchantId,
        submittedByUserId: catalog.userId,
        status: "PENDING_CHECKER" as never,
        onboardingChannel: "SELF_SERVICE" as never,
        slaDueAt: new Date(NOW.getTime() + 5 * 86_400_000),
        approvalRequestId: joinApproval,
      },
    });
    created.joinRequests.push(joinRequest.id);
    await client.approvalRequest.update({ where: { id: joinApproval }, data: { subjectId: joinRequest.id } });
    const caseApproval = await approval(catalog, { state: "PENDING_REVIEW", expiresInHours: -1, subjectType: "OPERATOR_CASE" });
    const operatorCase = await client.operatorCase.create({
      data: { kind: "MANUAL_REVIEW", priority: "P3", state: "PENDING_CHECKER", slaDueAt: new Date(NOW.getTime() + HOUR), subjectKey: `hk-case-${catalog.label}` },
    });
    created.cases.push(operatorCase.id);
    await client.approvalRequest.update({ where: { id: caseApproval }, data: { subjectId: operatorCase.id } });

    await worker().runOnce();

    const state = async (id: string) => (await client.approvalRequest.findUniqueOrThrow({ where: { id } })).state;
    for (const id of [stale, staleDraft, joinApproval, caseApproval]) expect(await state(id)).toBe("EXPIRED");
    expect(await state(future)).toBe("PENDING_REVIEW");
    for (const own of [chargeback, cashoutAlias, amlCase]) expect(await state(own)).toBe("PENDING_REVIEW");
    expect(await state(emergency)).toBe("PENDING_REVIEW");
    expect(await auditCount("APPROVAL_REQUEST_EXPIRED", emergency)).toBe(0);
    expect(await state(noExpiry)).toBe("PENDING_REVIEW");
    expect([await state(decided[0]!), await state(decided[1]!), await state(decided[2]!)]).toEqual(["APPROVED", "EXECUTED", "REJECTED"]);
    expect((await client.approvalRequest.findUniqueOrThrow({ where: { id: stale } })).rejectionReason).toBe(
      `EXPIRED: not decided before ${new Date(NOW.getTime() - 2 * HOUR).toISOString().slice(0, 19)}Z`,
    );
    expect(await auditCount("APPROVAL_REQUEST_EXPIRED", stale)).toBe(1);
    expect(await auditCount("APPROVAL_REQUEST_EXPIRED", future)).toBe(0);

    // subjects released exactly like a rejection would
    const released = await client.joinRequest.findUniqueOrThrow({ where: { id: joinRequest.id } });
    expect(released.status).toBe("IN_REVIEW");
    expect(released.approvalRequestId).toBeNull();
    expect((await client.operatorCase.findUniqueOrThrow({ where: { id: operatorCase.id } })).state).toBe("IN_PROGRESS");
    expect(await auditCount("JOIN_REQUEST_APPROVAL_EXPIRED", joinRequest.id)).toBe(1);
    expect(await auditCount("OPERATOR_CASE_RESOLUTION_EXPIRED", operatorCase.id)).toBe(1);

    // the maker is told once per approval, in both channels (internal staff notice)
    const notices = await client.notification.findMany({ where: { templateCode: "APPROVAL_REQUEST_EXPIRED", eventId: { startsWith: `notice:approval-expired:${stale}` } } });
    expect(notices.map((row) => row.channel).sort()).toEqual(["EMAIL", "IN_APP"]);
    expect(notices.every((row) => row.recipientUserId === catalog.userId)).toBe(true);
    const template = await client.notificationTemplate.findFirstOrThrow({ where: { code: "APPROVAL_REQUEST_EXPIRED" } });
    expect(template.confidentialityClass).toBe("INTERNAL");

    // a second tick (or a restart) changes nothing
    await worker().runOnce();
    expect(await auditCount("APPROVAL_REQUEST_EXPIRED", stale)).toBe(1);
    expect(await client.notification.count({ where: { eventId: { startsWith: `notice:approval-expired:${stale}` } } })).toBe(2);
  });

  test("an expired approval can no longer be approved or rejected, even though the lazy expiry check is not what stops it", async () => {
    const catalog = await catalogOf();
    const authorities = ["approval:check", "approval:read", "approval:write"];
    const checker = await client.user.create({
      data: {
        email: `hk-checker-${randomUUID().slice(0, 8)}@gateway.test`,
        role: "FINANCE",
        status: "ACTIVE",
        authoritiesMap: Object.fromEntries(authorities.map((authority) => [authority, true])),
        isMaker: false,
        isChecker: true,
        mfaRequired: false,
      },
    });
    created.users.push(checker.id);
    const token = signSession({ sub: checker.id, role: "FINANCE", merchantId: null, authorities, appScopeIds: [], mfa: true }, "admin");
    setAuthStateStore(new MemoryAuthStateStore());
    await resetAuthThrottles();
    const id = await approval(catalog, { state: "PENDING_REVIEW", expiresInHours: -1 });
    await worker().runOnce();
    expect((await client.approvalRequest.findUniqueOrThrow({ where: { id } })).state).toBe("EXPIRED");

    const app = express();
    app.use(express.json());
    app.use("/internal/admin", adminInternalRouter);
    app.use((error: unknown, _request: express.Request, response: express.Response, _next: unknown) => {
      response.status(isApiError(error) ? error.statusCode : 500).json(toErrorEnvelope(error));
    });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const call = async (path: string, body: unknown) => {
        const response = await fetch(`${base}/internal/admin${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as { code?: string } };
      };
      const approve = await call(`/approvals/${id}/approve`, {});
      expect(approve.status).toBe(409);
      expect(approve.body.code).toBe("APPROVAL_NOT_PENDING"); // the STATE stops it, not the expiry clock
      const reject = await call(`/approvals/${id}/reject`, { reason: "late" });
      expect(reject.status).toBe(409);
      expect(reject.body.code).toBe("APPROVAL_NOT_PENDING");
    } finally {
      server.close();
    }
    expect((await client.approvalRequest.findUniqueOrThrow({ where: { id } })).state).toBe("EXPIRED");
  });
});

describeDb("staff invitations (AUTO-05)", () => {
  test("an expired invitation loses its token, its queued mail is suppressed and unsealed, and the inviter is told", async () => {
    const catalog = await catalogOf();
    const inviter = catalog.userId;
    const mkUser = async (input: { status: "INVITED" | "ACTIVE"; expiresInHours: number; token?: string | null }) => {
      const user = await client.user.create({
        data: {
          email: `hk-invitee-${randomUUID().slice(0, 8)}@gateway.test`,
          role: "SUPPORT",
          authoritiesMap: {},
          status: input.status,
          invitedById: inviter,
          invitationTokenHash: input.token === null ? null : (input.token ?? "a".repeat(64)),
          invitationExpiresAt: new Date(NOW.getTime() + input.expiresInHours * HOUR),
        },
      });
      created.users.push(user.id);
      return user;
    };
    const expired = await mkUser({ status: "INVITED", expiresInHours: -3 });
    const fresh = await mkUser({ status: "INVITED", expiresInHours: 48 });
    const accepted = await mkUser({ status: "ACTIVE", expiresInHours: -3 });
    const queued = await client.notification.create({
      data: {
        eventId: `hk-invite-${randomUUID()}`,
        recipientUserId: expired.id,
        templateCode: "STAFF_INVITATION",
        channel: "EMAIL",
        lang: "EN",
        payloadJson: { tokenCiphertext: "sealed-token" },
        addressMasked: "in***@gateway.test",
        addressCiphertext: "sealed-address",
        status: "QUEUED",
      },
    });
    created.notifications.push(queued.id);

    await worker().runOnce();

    expect((await client.user.findUniqueOrThrow({ where: { id: expired.id } })).invitationTokenHash).toBeNull();
    expect((await client.user.findUniqueOrThrow({ where: { id: fresh.id } })).invitationTokenHash).not.toBeNull();
    expect((await client.user.findUniqueOrThrow({ where: { id: accepted.id } })).invitationTokenHash).not.toBeNull(); // an active user is never touched
    const mail = await client.notification.findUniqueOrThrow({ where: { id: queued.id } });
    expect(mail.status).toBe("SUPPRESSED");
    expect(mail.payloadJson).toEqual({});
    expect(await auditCount("STAFF_INVITATION_EXPIRED", expired.id)).toBe(1);
    const notice = await client.notification.findMany({ where: { templateCode: "STAFF_INVITATION_EXPIRED", recipientUserId: inviter, eventId: { startsWith: `notice:invitation-expired:${expired.id}` } } });
    expect(notice).toHaveLength(2);
    expect(JSON.stringify(notice[0]!.payloadJson)).toContain("***@"); // the invitee's address is masked in the notice

    await worker().runOnce();
    expect(await auditCount("STAFF_INVITATION_EXPIRED", expired.id)).toBe(1);
  });
});

describeDb("payment links (AUTO-11)", () => {
  const link = async (catalog: AutomationCatalog, state: string, expiresInHours: number | null) => {
    const row = await client.paymentLink.create({
      data: {
        key: `hk-link-${randomUUID().slice(0, 10)}`,
        applicationId: catalog.applicationId,
        walletId: catalog.walletId,
        amount: "10.0000",
        currency: "LYD",
        feeBearer: "MERCHANT_ABSORBS",
        useCount: 1,
        state: state as never,
        expiresAt: expiresInHours === null ? null : new Date(NOW.getTime() + expiresInHours * HOUR),
      },
    });
    created.links.push(row.id);
    return row.id;
  };

  test("a pending link past its expiry becomes EXPIRED with one link.expired event for its merchant; nothing else changes", async () => {
    const catalog = await catalogOf();
    const expired = await link(catalog, "PENDING", -5);
    const fresh = await link(catalog, "PENDING", 5);
    const open = await link(catalog, "PENDING", null);
    const completed = await link(catalog, "COMPLETED", -5);

    await worker().runOnce();
    const state = async (id: string) => (await client.paymentLink.findUniqueOrThrow({ where: { id } })).state;
    expect([await state(expired), await state(fresh), await state(open), await state(completed)]).toEqual(["EXPIRED", "PENDING", "PENDING", "COMPLETED"]);
    const events = await client.$queryRawUnsafe<Array<{ merchant_id: string; payload_json: Record<string, unknown>; processed_at: Date | null }>>(
      `SELECT merchant_id::text, payload_json, processed_at FROM outbox_events WHERE topic = 'link.expired' AND aggregate_id = $1`,
      expired,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.merchant_id).toBe(catalog.merchantId);
    expect(events[0]!.payload_json).toMatchObject({ linkId: expired, expiredAt: NOW.toISOString() });
    await worker().runOnce();
    expect(Number((await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM outbox_events WHERE topic = 'link.expired' AND aggregate_id = $1`, expired))[0]!.n)).toBe(1);
    expect(await state(fresh)).toBe("PENDING");
  });

  test("the work is bounded per batch and continues on the next tick", async () => {
    const catalog = await catalogOf();
    const ids = await Promise.all(Array.from({ length: 5 }, () => link(catalog, "PENDING", -9)));
    const w = worker({ batchSize: 2, maxBatchesPerTick: 2 });
    await w.runOnce();
    const expiredCount = async () => (await client.paymentLink.findMany({ where: { id: { in: ids } } })).filter((row) => row.state === "EXPIRED").length;
    expect(await expiredCount()).toBe(4);
    await w.runOnce();
    expect(await expiredCount()).toBe(5);
  });
});

describeDb("MFA challenges, sealed secrets and session revocations (AUTO-05)", () => {
  test("old challenges are deleted, recent and live ones are kept", async () => {
    const catalog = await catalogOf();
    const challenge = async (input: { expiresInHours: number; consumedHoursAgo?: number }) => {
      const row = await client.mfaChallenge.create({
        data: {
          userId: catalog.userId,
          channel: "ADMIN",
          codeHash: "b".repeat(64),
          expiresAt: new Date(NOW.getTime() + input.expiresInHours * HOUR),
          ...(input.consumedHoursAgo !== undefined ? { consumedAt: new Date(NOW.getTime() - input.consumedHoursAgo * HOUR) } : {}),
        },
      });
      created.challenges.push(row.id);
      return row.id;
    };
    const oldExpired = await challenge({ expiresInHours: -40 });
    const oldConsumed = await challenge({ expiresInHours: 1, consumedHoursAgo: 30 });
    const recentExpired = await challenge({ expiresInHours: -2 });
    const recentConsumed = await challenge({ expiresInHours: 1, consumedHoursAgo: 2 });
    const live = await challenge({ expiresInHours: 1 });
    await worker().runOnce();
    const remaining = new Set((await client.mfaChallenge.findMany({ where: { id: { in: [oldExpired, oldConsumed, recentExpired, recentConsumed, live] } } })).map((row) => row.id));
    expect([...remaining].sort()).toEqual([recentExpired, recentConsumed, live].sort());
  });

  test("the sealed code or token leaves a finished notification after the scrub delay, and never a queued one", async () => {
    const catalog = await catalogOf();
    const note = async (status: string, minutesOld: number, payload: Record<string, unknown>) => {
      const row = await client.notification.create({
        data: {
          eventId: `hk-secret-${randomUUID()}`,
          recipientUserId: catalog.userId,
          templateCode: "LOGIN_MFA",
          channel: "SMS",
          lang: "EN",
          payloadJson: payload as never,
          addressMasked: "*******1234",
          addressCiphertext: "sealed-address",
          status: status as never,
          updatedAt: new Date(NOW.getTime() - minutesOld * 60_000),
        },
      });
      created.notifications.push(row.id);
      return row.id;
    };
    const sentOld = await note("SENT", 120, { codeCiphertext: "sealed-code", other: 1 });
    const failedOld = await note("FAILED", 120, { tokenCiphertext: "sealed-token" });
    const sentRecent = await note("SENT", 10, { codeCiphertext: "sealed-code" });
    const queuedOld = await note("QUEUED", 500, { codeCiphertext: "sealed-code" });
    const plainOld = await note("DELIVERED", 500, { subject: "x" });
    await worker().runOnce();
    const payload = async (id: string) => (await client.notification.findUniqueOrThrow({ where: { id } })).payloadJson;
    expect(await payload(sentOld)).toEqual({ other: 1 });
    expect(await payload(failedOld)).toEqual({});
    expect(await payload(sentRecent)).toEqual({ codeCiphertext: "sealed-code" });
    expect(await payload(queuedOld)).toEqual({ codeCiphertext: "sealed-code" }); // still to be sent: never scrubbed
    expect(await payload(plainOld)).toEqual({ subject: "x" });
  });

  test("expired session revocations are deleted, live ones kept", async () => {
    const expired = `hk-jti-${randomUUID()}`;
    const live = `hk-jti-${randomUUID()}`;
    created.jtis.push(expired, live);
    await client.sessionRevocation.createMany({ data: [
      { jti: expired, expiresAt: new Date(NOW.getTime() - HOUR) },
      { jti: live, expiresAt: new Date(NOW.getTime() + HOUR) },
    ] });
    await worker().runOnce();
    expect(await client.sessionRevocation.findUnique({ where: { jti: expired } })).toBeNull();
    expect(await client.sessionRevocation.findUnique({ where: { jti: live } })).not.toBeNull();
  });
});

describeDb("isolation of the passes", () => {
  test("a failing pass is reported at the end of the tick and never stops the others", async () => {
    const catalog = await catalogOf();
    const id = await approval(catalog, { state: "PENDING_REVIEW", expiresInHours: -1 });
    const expiredJti = `hk-jti-${randomUUID()}`;
    created.jtis.push(expiredJti);
    await client.sessionRevocation.create({ data: { jti: expiredJti, expiresAt: new Date(NOW.getTime() - HOUR) } });
    const w = worker({
      notify: async () => {
        throw new Error("notification outbox unavailable");
      },
    });
    await expect(w.runOnce()).rejects.toThrow(/housekeeping passes failed \(approvals: notification outbox unavailable\)/);
    expect(w.lastSummary?.failed).toEqual(["approvals"]); // the summary of the failed tick is kept for diagnostics
    // the failed pass rolled its batch back (no approval closed without its notice) ...
    expect((await client.approvalRequest.findUniqueOrThrow({ where: { id } })).state).toBe("PENDING_REVIEW");
    // ... and the independent pass still ran
    expect(await client.sessionRevocation.findUnique({ where: { jti: expiredJti } })).toBeNull();
    await worker().runOnce();
    expect((await client.approvalRequest.findUniqueOrThrow({ where: { id } })).state).toBe("EXPIRED");
  });
});
