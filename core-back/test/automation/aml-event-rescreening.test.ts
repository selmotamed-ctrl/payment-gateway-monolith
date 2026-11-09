/**
 * AUTO-24 event-driven AML re-screening against live PostgreSQL: a new watch list version re-screens every ACTIVE
 * merchant at once (resumable across restarts), and an owner added after onboarding is screened as soon as it is seen,
 * exactly once. The merchant is never told (tipping-off).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaRepositories } from "../../engine/db/repositories";
import { InternalWatchlistProvider } from "../../engine/guards/ScreeningProvider";
import { AML_LIST_FINGERPRINT_KEY, AML_LIST_SWEEP_KEY, PeriodicScreeningWorker } from "../../engine/workers/PeriodicScreeningWorker";
import { InMemoryWorkerCursorStore } from "../../engine/workers/workerCursorStore";
import { cleanupAutomationCatalog, createAutomationCatalog, type AutomationCatalog } from "../helpers/automationCatalog";
import { createPrisma, databaseIsReachable } from "../storage-engine/helpers/db";

const client = createPrisma({ max: 10 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const catalogs: AutomationCatalog[] = [];
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const STARTED = new Date();
const SANCTIONED = "محمد علي";
const entry = { entryRef: "SAN-AUTO24", listType: "SANCTIONS" as const, listName: "Automation test list", names: [SANCTIONED] };

afterAll(async () => {
  if (databaseIsReachable) {
    const merchantIds = catalogs.map((catalog) => catalog.merchantId);
    // the sweep screens EVERY active merchant of the shared database: remove the rows this run created
    await client.$executeRawUnsafe(`DELETE FROM aml_cases WHERE subject_id = ANY($1::text[]) OR created_at >= $2`, merchantIds, STARTED);
    await client.$executeRawUnsafe(`DELETE FROM aml_screening_matches WHERE screening_id IN (SELECT id FROM aml_screenings WHERE trigger::text IN ('LIST_UPDATE', 'OWNER_CHANGE') AND requested_at >= $1)`, STARTED);
    await client.$executeRawUnsafe(`DELETE FROM aml_screenings WHERE trigger::text IN ('LIST_UPDATE', 'OWNER_CHANGE') AND requested_at >= $1`, STARTED);
    await client.$executeRawUnsafe(`DELETE FROM beneficial_owners WHERE merchant_id = ANY($1::uuid[])`, merchantIds);
    await cleanupAutomationCatalog(client, catalogs);
  }
  await client.$disconnect();
});

const provider = () =>
  new InternalWatchlistProvider({ entries: [], potentialScoreThreshold: 75, confirmedScoreThreshold: 95, listVersions: { SANCTIONS: "v1" } });

const worker = (screening: InternalWatchlistProvider, cursors: InMemoryWorkerCursorStore, screenBatchSize = 100_000) =>
  new PeriodicScreeningWorker({
    db: client as never,
    repositories: new PrismaRepositories(client as never),
    screening,
    cursors,
    logger: quiet,
    healthRegistry: null,
    screenBatchSize,
    rescreenIntervalMs: 365 * 86_400_000, // the daily periodic pass must not interfere
  });

const merchantOf = async (name: string | null): Promise<AutomationCatalog> => {
  const catalog = await createAutomationCatalog(client, { label: "amlevent" });
  catalogs.push(catalog);
  if (name) await client.merchant.update({ where: { id: catalog.merchantId }, data: { legalName: name, tradeName: name } });
  return catalog;
};

const screenings = (merchantId: string, trigger: string) =>
  client.amlScreening.findMany({ where: { subjectType: "MERCHANT", subjectId: merchantId, trigger: trigger as never } });

describeDb("list-update re-screening", () => {
  test("a new watch list version re-screens every active merchant now: a new match opens a case and suspends, the merchant is told nothing", async () => {
    const listed = await merchantOf(SANCTIONED);
    const innocent = await merchantOf(null);
    const cursors = new InMemoryWorkerCursorStore();
    const screening = provider();

    await worker(screening, cursors).runOnce(); // the first fingerprint only seeds the baseline
    expect(await cursors.read(AML_LIST_FINGERPRINT_KEY)).not.toBeNull();
    expect(await screenings(listed.merchantId, "LIST_UPDATE")).toHaveLength(0);
    expect((await client.merchant.findUniqueOrThrow({ where: { id: listed.merchantId } })).status).toBe("ACTIVE");

    screening.setEntries([entry]);
    screening.setListVersions({ SANCTIONS: "v2" });
    await worker(screening, cursors).runOnce();

    const rows = await screenings(listed.merchantId, "LIST_UPDATE");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result).toBe("CONFIRMED_MATCH");
    expect((await screenings(innocent.merchantId, "LIST_UPDATE"))).toHaveLength(1); // everybody is re-screened
    expect((await screenings(innocent.merchantId, "LIST_UPDATE"))[0]!.result).toBe("CLEAR");
    const merchant = await client.merchant.findUniqueOrThrow({ where: { id: listed.merchantId } });
    expect(merchant.status).toBe("SUSPENDED");
    expect(merchant.suspensionReasonCode).toBe("AML_CONFIRMED_MATCH");
    expect(await client.amlCase.count({ where: { subjectId: listed.merchantId, triggerReason: { startsWith: "SCREENING_CONFIRMED_MATCH" } } })).toBe(1);
    expect((await client.merchant.findUniqueOrThrow({ where: { id: innocent.merchantId } })).status).toBe("ACTIVE");
    // tipping-off: nothing reaches the merchant
    expect(await client.notification.count({ where: { recipientMerchantId: listed.merchantId } })).toBe(0);
    // the sweep is finished and audited; a further tick does not repeat it
    expect(await cursors.read(AML_LIST_SWEEP_KEY)).toBeNull();
    const audits = await client.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_log WHERE action LIKE 'AML_LIST_UPDATE_SWEEP_%' AND created_at >= $1`, STARTED);
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining(["AML_LIST_UPDATE_SWEEP_STARTED", "AML_LIST_UPDATE_SWEEP_FINISHED"]));
    await worker(screening, cursors).runOnce();
    expect(await screenings(innocent.merchantId, "LIST_UPDATE")).toHaveLength(1);
  });

  test("a sweep resumes where it stopped after a restart, screens each merchant once, and a suspended merchant is skipped", async () => {
    const a = await merchantOf(null);
    const b = await merchantOf(null);
    const cursors = new InMemoryWorkerCursorStore();
    const screening = provider();
    await worker(screening, cursors, 3).runOnce(); // baseline
    screening.setListVersions({ SANCTIONS: "v9" });
    await client.merchant.update({ where: { id: b.merchantId }, data: { status: "SUSPENDED" } });

    await worker(screening, cursors, 3).runOnce(); // starts the sweep, screens the first 3 merchants (id order)
    const midway = await cursors.read(AML_LIST_SWEEP_KEY);
    expect(midway).not.toBeNull();
    expect(JSON.parse(midway!).afterId).toEqual(expect.any(String));
    // The shared database holds every merchant earlier suites created (hundreds), so after proving the resume with a
    // second small batch the rest of the sweep runs with a larger one. A NEW instance every tick: the cursor carries the progress.
    await worker(screening, cursors, 3).runOnce();
    for (let tick = 0; tick < 200 && (await cursors.read(AML_LIST_SWEEP_KEY)) !== null; tick += 1) {
      await worker(screening, cursors, 100).runOnce();
    }
    expect(await cursors.read(AML_LIST_SWEEP_KEY)).toBeNull();
    expect(await screenings(a.merchantId, "LIST_UPDATE")).toHaveLength(1); // exactly once
    expect(await screenings(b.merchantId, "LIST_UPDATE")).toHaveLength(0); // not ACTIVE
  });

  test("a second list change while a sweep runs restarts it from the beginning", async () => {
    const a = await merchantOf(null);
    const cursors = new InMemoryWorkerCursorStore();
    const screening = provider();
    await worker(screening, cursors, 2).runOnce();
    screening.setListVersions({ SANCTIONS: "v20" });
    await worker(screening, cursors, 2).runOnce();
    const first = JSON.parse((await cursors.read(AML_LIST_SWEEP_KEY))!);
    screening.setListVersions({ SANCTIONS: "v21" });
    await worker(screening, cursors, 2).runOnce();
    const second = JSON.parse((await cursors.read(AML_LIST_SWEEP_KEY))!);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.screened).toBeLessThanOrEqual(2); // restarted: only the batch of this tick counts
    void a;
    // finish it so no later test inherits a half-done sweep
    for (let tick = 0; tick < 300 && (await cursors.read(AML_LIST_SWEEP_KEY)) !== null; tick += 1) await worker(screening, cursors, 500).runOnce();
  });
});

describeDb("owner-change screening", () => {
  const owner = (merchantId: string, overrides: Record<string, unknown> = {}) =>
    client.beneficialOwner.create({
      data: {
        merchantId,
        fullNameAr: SANCTIONED,
        nationalIdCiphertext: "sealed",
        dateOfBirth: new Date("1980-01-01"),
        nationality: "LY",
        role: "OWNER",
        validFrom: new Date(),
        screeningStatus: "NOT_SCREENED",
        ...overrides,
      },
    });

  test("an owner added to an active merchant is screened once with the trigger OWNER_CHANGE; owners of inactive merchants or inactive owners are not", async () => {
    const active = await merchantOf(null);
    const pending = await merchantOf(null);
    await client.merchant.update({ where: { id: pending.merchantId }, data: { status: "PENDING" } });
    const inactiveOwnerMerchant = await merchantOf(null);
    const added = await owner(active.merchantId);
    const onPending = await owner(pending.merchantId);
    const retired = await owner(inactiveOwnerMerchant.merchantId, { active: false });

    const cursors = new InMemoryWorkerCursorStore();
    const screening = provider();
    screening.setEntries([entry]);
    await worker(screening, cursors).runOnce(); // baseline (no sweep) + the owner pass
    await worker(screening, cursors).runOnce();

    expect(await screenings(active.merchantId, "OWNER_CHANGE")).toHaveLength(1);
    expect((await client.beneficialOwner.findUniqueOrThrow({ where: { id: added.id } })).screeningStatus).toBe("CONFIRMED_MATCH");
    expect((await client.beneficialOwner.findUniqueOrThrow({ where: { id: onPending.id } })).screeningStatus).toBe("NOT_SCREENED");
    expect((await client.beneficialOwner.findUniqueOrThrow({ where: { id: retired.id } })).screeningStatus).toBe("NOT_SCREENED");
    expect(await screenings(pending.merchantId, "OWNER_CHANGE")).toHaveLength(0);
    expect(await screenings(inactiveOwnerMerchant.merchantId, "OWNER_CHANGE")).toHaveLength(0);
    // a confirmed owner match stops the merchant like any other confirmed match
    expect((await client.merchant.findUniqueOrThrow({ where: { id: active.merchantId } })).status).toBe("SUSPENDED");
    expect(await client.notification.count({ where: { recipientMerchantId: active.merchantId } })).toBe(0);
  });
});
