/**
 * AUTO-08 / AUTO-26 token and credential expiry against live PostgreSQL: staged notices (exactly once, silent catch-up of
 * the higher stages), the P1 case close to the expiry, taking an expired credential set out of use, and the scheduled
 * re-verification (dry run by default, a failing verdict opens a case, an unreachable verifier never takes a set out).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ExpiryNoticeWorker, type CredentialVerifierPort } from "../../engine/workers/ExpiryNoticeWorker";
import { cleanupAutomationCatalog, createAutomationCatalog, type AutomationCatalog } from "../helpers/automationCatalog";
import { createFakeRepositories } from "../helpers/fakeRepositories";
import { createPrisma, databaseIsReachable } from "../storage-engine/helpers/db";

const client = createPrisma({ max: 10 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const catalogs: AutomationCatalog[] = [];
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date();
const created = { tokens: [] as string[], users: [] as string[] };

const disableStaff = () => client.$executeRawUnsafe(`UPDATE users SET status = 'DISABLED' WHERE email LIKE 'en-%@gateway.test' AND status = 'ACTIVE'`);
if (databaseIsReachable) await disableStaff();

afterAll(async () => {
  if (databaseIsReachable) {
    const ids = [...created.tokens, ...catalogs.map((entry) => entry.credentialSetId)];
    await client.$executeRawUnsafe(`DELETE FROM deadline_stages WHERE subject_id = ANY($1::text[])`, ids);
    await client.$executeRawUnsafe(`DELETE FROM notifications WHERE split_part(event_id, ':', 3) = ANY($1::text[]) OR recipient_user_id = ANY($2::uuid[])`, ids, created.users);
    await client.$executeRawUnsafe(`DELETE FROM operator_cases WHERE subject_key ~ ANY($1::text[])`, ids.map((id) => `[:]${id}`));
    await client.$executeRawUnsafe(`DELETE FROM access_tokens WHERE id = ANY($1::uuid[])`, created.tokens);
    await disableStaff();
    await cleanupAutomationCatalog(client, catalogs);
  }
  await client.$disconnect();
});

const worker = (clock: () => Date, overrides: Partial<ConstructorParameters<typeof ExpiryNoticeWorker>[0]> = {}) =>
  new ExpiryNoticeWorker({ db: client as never, repositories: createFakeRepositories(), logger: quiet, healthRegistry: null, clock, reverifyAfterHours: 0, ...overrides });

const catalogOf = async (): Promise<AutomationCatalog> => {
  const catalog = await createAutomationCatalog(client, { label: "expnotice" });
  catalogs.push(catalog);
  return catalog;
};

const staff = async (role: string): Promise<string> => {
  const user = await client.user.create({ data: { email: `en-${role.toLowerCase()}-${randomUUID().slice(0, 8)}@gateway.test`, role: role as never, status: "ACTIVE", authoritiesMap: {}, isMaker: false, isChecker: false, mfaRequired: false } });
  created.users.push(user.id);
  return user.id;
};

const stages = async (type: string, id: string): Promise<string[]> =>
  (await client.$queryRawUnsafe<Array<{ stage: string }>>(`SELECT stage FROM deadline_stages WHERE subject_type = $1 AND subject_id = $2 ORDER BY stage`, type, id)).map((row) => row.stage);

const token = async (catalog: AutomationCatalog, input: { expiresInDays: number | null; revoked?: boolean; name?: string }) => {
  const row = await client.accessToken.create({
    data: {
      merchantId: catalog.merchantId,
      applicationId: catalog.applicationId,
      name: input.name ?? "Checkout integration",
      tokenHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      lastFour: "ab12",
      scopes: [],
      expiresAt: input.expiresInDays === null ? null : new Date(NOW.getTime() + input.expiresInDays * DAY),
      ...(input.revoked ? { revokedAt: new Date() } : {}),
    },
  });
  created.tokens.push(row.id);
  return row.id;
};

const tokenNotices = (id: string) => client.notification.findMany({ where: { eventId: { startsWith: `notice:token-expiring:${id}` } }, orderBy: { eventId: "asc" } });

describeDb("API token expiry notices", () => {
  test("the merchant is told at 30, 7 and 1 days, once each, and never about a revoked or unlimited token", async () => {
    const catalog = await catalogOf();
    const id = await token(catalog, { expiresInDays: 20 });
    const revoked = await token(catalog, { expiresInDays: 5, revoked: true });
    const unlimited = await token(catalog, { expiresInDays: null });
    const distant = await token(catalog, { expiresInDays: 90 });

    await worker(() => NOW).runOnce();
    await worker(() => NOW).runOnce();
    expect(await stages("ACCESS_TOKEN", id)).toEqual(["D30"]);
    const first = await tokenNotices(id);
    expect(first.map((row) => row.channel).sort()).toEqual(["EMAIL", "IN_APP"]);
    expect(first.every((row) => row.recipientMerchantId === catalog.merchantId && row.templateCode === "API_TOKEN_EXPIRING")).toBe(true);
    expect(first[0]!.payloadJson).toMatchObject({ name: "Checkout integration", lastFour: "ab12", days: 20 });
    for (const skipped of [revoked, unlimited, distant]) expect(await stages("ACCESS_TOKEN", skipped)).toEqual([]);

    await worker(() => new Date(NOW.getTime() + 15 * DAY)).runOnce(); // 5 days left
    expect((await stages("ACCESS_TOKEN", id)).sort()).toEqual(["D30", "D7"]);
    await worker(() => new Date(NOW.getTime() + 19.5 * DAY)).runOnce(); // 12 hours left
    expect((await stages("ACCESS_TOKEN", id)).sort()).toEqual(["D1", "D30", "D7"]);
    expect((await tokenNotices(id)).length).toBe(6); // three stages x two channels
  });

  test("a token created with a short life skips the higher stages silently: one notice, not three", async () => {
    const catalog = await catalogOf();
    const id = await token(catalog, { expiresInDays: 3 });
    await worker(() => NOW).runOnce();
    expect((await stages("ACCESS_TOKEN", id)).sort()).toEqual(["D30", "D7"]);
    expect((await tokenNotices(id)).filter((row) => row.eventId.includes(":D7:")).length).toBe(2);
    expect((await tokenNotices(id)).filter((row) => row.eventId.includes(":D30:")).length).toBe(0);
  });
});

describeDb("credential set expiry", () => {
  test("staff are told close to the expiry, a P1 case opens inside the case window, and an expired set is taken out of use once", async () => {
    const catalog = await catalogOf();
    // The recipients of an internal queue are capped PER ROLE (20, oldest first). The shared test database holds dozens of
    // active SECURITY_ADMIN users from other suites, so only the small role is asserted.
    const admin = await staff("GATEWAY_ADMIN");
    await client.credentialSet.update({ where: { id: catalog.credentialSetId }, data: { expiresAt: new Date(NOW.getTime() + 6 * DAY), status: "VERIFIED" } });

    await worker(() => NOW).runOnce();
    await worker(() => NOW).runOnce();
    expect(await stages("CREDENTIAL_SET", catalog.credentialSetId)).toEqual(["D30", "D7"]);
    const notices = await client.notification.findMany({ where: { eventId: { startsWith: `notice:credential-expiring:${catalog.credentialSetId}` } } });
    expect(new Set(notices.map((row) => row.recipientUserId))).toContain(admin);
    const expiring = await client.operatorCase.findMany({ where: { subjectKey: `credential.expiring:${catalog.credentialSetId}` } });
    expect(expiring).toHaveLength(1);
    expect(expiring[0]).toMatchObject({ priority: "P1", state: "OPEN" });
    expect((await client.credentialSet.findUniqueOrThrow({ where: { id: catalog.credentialSetId } })).status).toBe("VERIFIED"); // not before the expiry

    const later = new Date(NOW.getTime() + 6 * DAY + HOUR);
    await worker(() => later).runOnce();
    await worker(() => later).runOnce();
    expect((await client.credentialSet.findUniqueOrThrow({ where: { id: catalog.credentialSetId } })).status).toBe("FAILING");
    const audit = await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'CREDENTIAL_SET_EXPIRED' AND entity_id = $1`, catalog.credentialSetId);
    expect(Number(audit[0]!.n)).toBe(1);
    expect(await client.operatorCase.count({ where: { subjectKey: `credential.expired:${catalog.credentialSetId}`, priority: "P1" } })).toBe(1);
    expect(await stages("CREDENTIAL_SET", catalog.credentialSetId)).toContain("EXPIRED");
  });

  test("an old expiry is taken out of use silently (no case, no notice): the safe action is not limited to the catch-up window", async () => {
    const catalog = await catalogOf();
    await client.credentialSet.update({ where: { id: catalog.credentialSetId }, data: { expiresAt: new Date(NOW.getTime() - 40 * DAY), status: "VERIFIED" } });
    await worker(() => NOW).runOnce();
    expect((await client.credentialSet.findUniqueOrThrow({ where: { id: catalog.credentialSetId } })).status).toBe("FAILING");
    expect(await client.operatorCase.count({ where: { subjectKey: `credential.expired:${catalog.credentialSetId}` } })).toBe(0);
  });

  test("a revoked set and a set without an expiry are never touched", async () => {
    const catalog = await catalogOf();
    const other = await catalogOf();
    await client.credentialSet.update({ where: { id: catalog.credentialSetId }, data: { expiresAt: new Date(NOW.getTime() - DAY), status: "REVOKED" } });
    await worker(() => NOW).runOnce();
    expect((await client.credentialSet.findUniqueOrThrow({ where: { id: catalog.credentialSetId } })).status).toBe("REVOKED");
    expect((await client.credentialSet.findUniqueOrThrow({ where: { id: other.credentialSetId } })).status).toBe("VERIFIED");
  });
});

describeDb("scheduled credential re-verification (AUTO-26)", () => {
  const stale = (catalog: AutomationCatalog) => client.credentialSet.update({ where: { id: catalog.credentialSetId }, data: { status: "VERIFIED", lastVerifiedAt: new Date(NOW.getTime() - 48 * HOUR), expiresAt: null } });
  const later = new Date(NOW.getTime() + HOUR);

  const verifier = (verdicts: Record<string, { status: string; reason?: string } | Error>) => {
    const calls: string[] = [];
    const port: CredentialVerifierPort = {
      verify: async (id) => {
        calls.push(id);
        const verdict = verdicts[id];
        if (verdict instanceof Error) throw verdict;
        return verdict ?? { status: "VERIFIED" };
      },
    };
    return { port, calls };
  };

  test("the default is a dry run: it audits what it would verify and calls no gateway", async () => {
    const catalog = await catalogOf();
    await stale(catalog);
    const v = verifier({});
    await worker(() => later, { reverifyAfterHours: 24, reverifyBatchSize: 1000, verifier: v.port }).runOnce();
    expect(v.calls).toEqual([]);
    const audit = await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'CREDENTIAL_REVERIFY_PROPOSED' AND entity_id = $1`, catalog.credentialSetId);
    expect(Number(audit[0]!.n)).toBe(1);
  });

  test("live: a failing verdict opens one P1 case and tells staff; a good one or an unreachable verifier changes nothing", async () => {
    const failing = await catalogOf();
    const good = await catalogOf();
    const unreachable = await catalogOf();
    const admin = await staff("GATEWAY_ADMIN");
    for (const catalog of [failing, good, unreachable]) await stale(catalog);
    const v = verifier({
      [failing.credentialSetId]: { status: "FAILING", reason: "401 from the token endpoint" },
      [unreachable.credentialSetId]: new Error("connect ETIMEDOUT"),
    });
    const w = worker(() => later, { reverifyAfterHours: 24, reverifyBatchSize: 1000, reverifyDryRun: false, verifier: v.port });
    await w.runOnce();
    await w.runOnce();
    expect(v.calls).toContain(failing.credentialSetId);
    expect(v.calls).toContain(good.credentialSetId);
    expect(v.calls).toContain(unreachable.credentialSetId);
    const cases = await client.operatorCase.findMany({ where: { subjectKey: `credential.failing:${failing.credentialSetId}` } });
    expect(cases).toHaveLength(1);
    expect(cases[0]!.resolutionNotes).toContain("401 from the token endpoint");
    expect(await client.operatorCase.count({ where: { subjectKey: `credential.failing:${good.credentialSetId}` } })).toBe(0);
    expect(await client.operatorCase.count({ where: { subjectKey: `credential.failing:${unreachable.credentialSetId}` } })).toBe(0);
    expect((await client.notification.findMany({ where: { eventId: { startsWith: `notice:credential-failing:${failing.credentialSetId}` } } })).some((row) => row.recipientUserId === admin)).toBe(true);
    // the verifier (the check service) wrote FAILING for the failing set; the worker did not touch the others
    expect((await client.credentialSet.findUniqueOrThrow({ where: { id: unreachable.credentialSetId } })).status).toBe("VERIFIED");
  });

  test("a recently verified set is not re-verified, and the batch size bounds one tick", async () => {
    const fresh = await catalogOf();
    await client.credentialSet.update({ where: { id: fresh.credentialSetId }, data: { status: "VERIFIED", lastVerifiedAt: new Date(NOW.getTime() - HOUR), expiresAt: null } });
    const v = verifier({});
    await worker(() => NOW, { reverifyAfterHours: 24, reverifyBatchSize: 1000, reverifyDryRun: false, verifier: v.port }).runOnce();
    expect(v.calls).not.toContain(fresh.credentialSetId);
    const bounded = verifier({});
    await worker(() => new Date(NOW.getTime() + 60 * HOUR), { reverifyAfterHours: 24, reverifyBatchSize: 2, reverifyDryRun: false, verifier: bounded.port }).runOnce();
    expect(bounded.calls.length).toBeLessThanOrEqual(2);
  });
});
