/**
 * AUTO-06 KYB scan worker against live PostgreSQL with a fake scanner: every state transition, the fail-closed retry
 * and backoff, quarantine (status, case, audit, notice), the re-scan of CLEAN documents, no-downgrade on a failed
 * re-scan, the guarded update, node-concurrency and the backlog monitor finding.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createFakeRepositories } from "../helpers/fakeRepositories";
import { KybScanWorker } from "../../engine/workers/KybScanWorker";
import { kybScanBacklogCheck } from "../../engine/workers/platformMonitorChecks";
import { KybScannerError, type KybScanner, type KybScanVerdict } from "../../lib/kybScanner";
import { cleanupAutomationCatalog, createAutomationCatalog, type AutomationCatalog } from "../helpers/automationCatalog";
import { createPrisma, databaseIsReachable } from "../storage-engine/helpers/db";

const client = createPrisma({ max: 10 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const catalogs: AutomationCatalog[] = [];
const DAY = 86_400_000;
// The REAL clock: documents of other suites are never touched because every worker here is scoped to its own merchant.
const NOW = new Date();
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** The bytes behind each fake StorageObject; the fake vault returns them without touching a blob store. */
const contentByObject = new Map<string, Buffer>();

const fakeObjectStorage = {
  workerClient: {
    readForScan: async (objectId: string) => {
      const bytes = contentByObject.get(objectId);
      if (!bytes) throw new KybScannerError("the document has no stored content to scan", false);
      return { objectId, bytes, detectedMimeType: "application/pdf" };
    },
    applyScanVerdict: async () => undefined,
  },
} as never;

afterAll(async () => {
  for (const catalog of catalogs) {
    await client.$executeRawUnsafe(`DELETE FROM kyb_documents WHERE merchant_id = $1::uuid`, catalog.merchantId);
  }
  await cleanupAutomationCatalog(client, catalogs);
  await client.$executeRawUnsafe(`DELETE FROM operator_cases WHERE subject_key LIKE 'kyb-%'`).catch(() => undefined);
  await client.$disconnect();
});

/** The "ciphertext" of these documents is base64 of the bytes; the worker's `openContent` is the inverse. */
const openContent = async (ciphertext: string): Promise<Buffer> => Buffer.from(ciphertext, "base64");

class FakeScanner implements KybScanner {
  readonly engine = "fake";
  scanned: string[] = [];
  failWith: Error | null = null;
  delayMs = 0;
  async scan(bytes: Buffer): Promise<KybScanVerdict> {
    this.scanned.push(bytes.toString());
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failWith) throw this.failWith;
    if (bytes.toString().includes("VIRUS")) return { verdict: "INFECTED", engine: "fake", signature: "fake/1", threat: "Fake.Virus" };
    return { verdict: "CLEAN", engine: "fake", signature: "fake/1" };
  }
}

const setup = async () => {
  const catalog = await createAutomationCatalog(client, { label: "kybscan" });
  catalogs.push(catalog);
  return catalog;
};

const document = async (
  catalog: AutomationCatalog,
  text: string,
  options: { avStatus?: string; status?: string; scannedDaysAgo?: number; content?: boolean } = {},
): Promise<string> => {
  const objectId = randomUUID();
  const sha256 = createHash("sha256").update(text + randomUUID()).digest("hex");
  await client.storageObject.create({
    data: {
      id: objectId,
      bucket: "HOT",
      namespace: "KYB_DOCUMENTS",
      storageKey: `kyb_documents/${catalog.merchantId}/2026/11/${objectId}.v1.enc`,
      status: "QUARANTINE_PENDING_AV",
      sha256Hex: sha256,
      byteSize: BigInt(Buffer.byteLength(text)),
      chunkSizeBytes: 65536,
      chunkCount: 1,
      detectedMimeType: "application/pdf",
      wrappedDek: new Uint8Array(48),
      dekNonce: new Uint8Array(12),
      streamNoncePrefix: new Uint8Array(7),
      uploadedByActorType: "SYSTEM_WORKER",
      uploadedByActorId: "test",
      requiredAuthority: "kyb:read",
      confidentialityTier: "RESTRICTED_PII",
      avScanStatus: "PENDING",
      stagingExpiresAt: new Date(NOW.getTime() + 3_600_000),
    },
  });
  if (options.content !== false) contentByObject.set(objectId, Buffer.from(text));
  return (
    await client.kybDocument.create({
      data: {
        merchantId: catalog.merchantId,
        subjectType: "MERCHANT",
        subjectId: catalog.merchantId,
        docType: "COMMERCIAL_REGISTRY" as never,
        storageKey: `kyb_documents/${catalog.merchantId}/2026/11/${objectId}.v1.enc`,
        storageObjectId: objectId,
        sha256,
        mime: "application/pdf",
        sizeBytes: text.length,
        avStatus: (options.avStatus ?? "PENDING") as never,
        status: (options.status ?? "UPLOADED") as never,
        uploadedById: catalog.userId,
        createdAt: new Date(NOW.getTime() - 3_600_000),
        avScannedAt: options.scannedDaysAgo === undefined ? null : new Date(NOW.getTime() - options.scannedDaysAgo * DAY),
      },
    })
  ).id;
};

const worker = (catalog: AutomationCatalog, scanner: KybScanner | null, extra: Partial<ConstructorParameters<typeof KybScanWorker>[0]> = {}) =>
  new KybScanWorker({
    db: client as never,
    repositories: createFakeRepositories(),
    logger: quiet,
    healthRegistry: null,
    clock: () => NOW,
    scanner,
    openContent,
    objectStorage: fakeObjectStorage,
    merchantIds: [catalog.merchantId],
    batchSize: 20,
    retryBaseMs: 60_000,
    retryMaxMs: 3_600_000,
    maxAttempts: 3,
    ...extra,
  });

/** A tick whose scans failed rejects (that is what the health registry records); the documents are already rescheduled. */
const runFailing = (instance: KybScanWorker): Promise<unknown> => instance.runOnce().catch(() => undefined);

const load = (id: string) => client.kybDocument.findUniqueOrThrow({ where: { id } });
const audits = async (id: string, action: string): Promise<number> =>
  Number((await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM audit_log WHERE action = $1 AND entity_id = $2`, action, id))[0]?.n ?? 0);

describeDb("KYB scan worker (live PostgreSQL)", () => {
  test("PENDING documents become CLEAN with the engine, signature version and one audit row; repeats do nothing", async () => {
    const catalog = await setup();
    const scanner = new FakeScanner();
    const id = await document(catalog, "plain registration");
    await worker(catalog, scanner).runOnce();

    const doc = await load(id);
    expect(doc.avStatus).toBe("CLEAN");
    expect(doc.avEngine).toBe("fake");
    expect(doc.avSignature).toBe("fake/1");
    expect(doc.avScannedAt).not.toBeNull();
    expect(doc.avScanAttempts).toBe(0);
    expect(doc.avNextScanAt).toBeNull();
    expect(doc.status).toBe("UPLOADED");
    expect(await audits(id, "KYB_DOCUMENT_SCANNED")).toBe(1);

    await worker(catalog, scanner).runOnce();
    await worker(catalog, scanner).runOnce();
    expect(scanner.scanned).toEqual(["plain registration"]);
    expect(await audits(id, "KYB_DOCUMENT_SCANNED")).toBe(1);
  });

  test("an infected upload is quarantined: REJECTED, undownloadable, one P1 case, one audit row, one neutral notice per channel", async () => {
    const catalog = await setup();
    const id = await document(catalog, "VIRUS payload");
    await worker(catalog, new FakeScanner()).runOnce();

    const doc = await load(id);
    expect(doc.avStatus).toBe("INFECTED");
    expect(doc.status).toBe("REJECTED");
    expect(doc.rejectionReasonCode).toBe("OTHER");
    expect(doc.reviewNotes).toMatch(/malware scan/);
    expect(await audits(id, "KYB_DOCUMENT_QUARANTINED")).toBe(1);

    const cases = await client.operatorCase.findMany({ where: { subjectKey: `kyb-infected:${id}` } });
    expect(cases).toHaveLength(1);
    expect(cases[0]!.priority).toBe("P1");
    expect(cases[0]!.resolutionNotes).toContain(id);
    expect(cases[0]!.resolutionNotes).toContain("Fake.Virus");

    const notices = await client.notification.findMany({ where: { eventId: { startsWith: `notice:kyb-quarantined:${id}` } } });
    expect(notices.map((row) => row.channel).sort()).toEqual(["EMAIL", "IN_APP"]);
    expect(notices.every((row) => row.recipientUserId === catalog.userId)).toBe(true);
    // the notice never names the detection
    const templates = await client.notificationTemplate.findMany({ where: { code: "KYB_DOCUMENT_QUARANTINED" } });
    expect(templates.length).toBe(4);
    expect(templates.map((row) => row.bodyTemplate).join(" ")).not.toMatch(/virus|malware|trojan|infect/i);

    await worker(catalog, new FakeScanner()).runOnce();
    expect(await client.operatorCase.count({ where: { subjectKey: `kyb-infected:${id}` } })).toBe(1);
    expect(await client.notification.count({ where: { eventId: { startsWith: `notice:kyb-quarantined:${id}` } } })).toBe(2);
  });

  test("fail closed: a scanner error keeps the document PENDING and retries with exponential backoff; success clears the error", async () => {
    const catalog = await setup();
    const scanner = new FakeScanner();
    scanner.failWith = new KybScannerError("clamd connection failed: ECONNREFUSED");
    const id = await document(catalog, "needs a scan");

    await expect(worker(catalog, scanner).runOnce()).rejects.toThrow(/1 scan\(s\) failed/);
    let doc = await load(id);
    expect(doc.avStatus).toBe("PENDING");
    expect(doc.avScanAttempts).toBe(1);
    expect(doc.avLastError).toMatch(/ECONNREFUSED/);
    expect(doc.avNextScanAt!.getTime()).toBe(NOW.getTime() + 60_000);

    // not due yet: a second tick at the same instant does not touch it
    await runFailing(worker(catalog, scanner));
    expect((await load(id)).avScanAttempts).toBe(1);

    // due: attempt 2 backs off twice as long
    const later = new Date(NOW.getTime() + 61_000);
    await runFailing(worker(catalog, scanner, { clock: () => later }));
    doc = await load(id);
    expect(doc.avScanAttempts).toBe(2);
    expect(doc.avNextScanAt!.getTime()).toBe(later.getTime() + 120_000);

    // the scanner comes back
    scanner.failWith = null;
    await worker(catalog, scanner, { clock: () => new Date(later.getTime() + 121_000) }).runOnce();
    doc = await load(id);
    expect(doc.avStatus).toBe("CLEAN");
    expect(doc.avLastError).toBeNull();
    expect(doc.avScanAttempts).toBe(0);
  });

  test("after maxAttempts failures ONE P2 case is opened and the retries continue", async () => {
    const catalog = await setup();
    const scanner = new FakeScanner();
    scanner.failWith = new KybScannerError("clamd did not answer within 30000 ms");
    const id = await document(catalog, "stuck");
    let clock = NOW;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      clock = new Date(clock.getTime() + 2 * 3_600_000);
      await runFailing(worker(catalog, scanner, { clock: () => clock }));
    }
    const doc = await load(id);
    expect(doc.avStatus).toBe("PENDING");
    expect(doc.avScanAttempts).toBe(5);
    const cases = await client.operatorCase.findMany({ where: { subjectKey: `kyb-scan-failed:${id}` } });
    expect(cases).toHaveLength(1);
    expect(cases[0]!.priority).toBe("P2");
    expect(cases[0]!.resolutionNotes).toMatch(/stays PENDING/);
  });

  test("a document with no stored content is escalated once, never marked CLEAN, and is not a scanner failure", async () => {
    const catalog = await setup();
    const scanner = new FakeScanner();
    const id = await document(catalog, "gone", { content: false });
    await worker(catalog, scanner).runOnce();
    const doc = await load(id);
    expect(doc.avStatus).toBe("PENDING");
    expect(doc.avLastError).toMatch(/no stored content/);
    expect(scanner.scanned).toEqual([]);
    expect(await client.operatorCase.count({ where: { subjectKey: `kyb-scan-failed:${id}` } })).toBe(1);
    // backed off to the cap, not hot-looped
    expect(doc.avNextScanAt!.getTime()).toBe(NOW.getTime() + 3_600_000);
  });

  test("a size-limit refusal from the engine is escalated at once (it will never succeed by retrying)", async () => {
    const catalog = await setup();
    const scanner = new FakeScanner();
    scanner.failWith = new KybScannerError("clamd could not scan the file: INSTREAM size limit exceeded. ERROR", false);
    const id = await document(catalog, "huge");
    await worker(catalog, scanner).runOnce();
    expect(await client.operatorCase.count({ where: { subjectKey: `kyb-scan-failed:${id}` } })).toBe(1);
    expect((await load(id)).avStatus).toBe("PENDING");
  });

  test("CLEAN documents are re-scanned after rescanDays; fresh ones, and rescanDays 0, are left alone", async () => {
    const catalog = await setup();
    const scanner = new FakeScanner();
    const old = await document(catalog, "old clean", { avStatus: "CLEAN", scannedDaysAgo: 40 });
    const fresh = await document(catalog, "fresh clean", { avStatus: "CLEAN", scannedDaysAgo: 5 });
    const never = await document(catalog, "legacy clean", { avStatus: "CLEAN" });

    await worker(catalog, scanner, { rescanDays: 0 }).runOnce();
    expect(scanner.scanned).toEqual([]);

    await worker(catalog, scanner, { rescanDays: 30 }).runOnce();
    expect(scanner.scanned.sort()).toEqual(["legacy clean", "old clean"]);
    expect((await load(old)).avScannedAt!.getTime()).toBe(NOW.getTime());
    expect((await load(never)).avEngine).toBe("fake");
    expect((await load(fresh)).avEngine).toBeNull();
    // a clean re-scan writes no new audit row
    expect(await audits(old, "KYB_DOCUMENT_SCANNED")).toBe(0);
    // and they are not due again
    scanner.scanned = [];
    await worker(catalog, scanner, { rescanDays: 30 }).runOnce();
    expect(scanner.scanned).toEqual([]);
  });

  test("a failed re-scan never downgrades a CLEAN document", async () => {
    const catalog = await setup();
    const scanner = new FakeScanner();
    scanner.failWith = new KybScannerError("clamd connection failed: ECONNRESET");
    const id = await document(catalog, "was clean", { avStatus: "CLEAN", scannedDaysAgo: 60 });
    await runFailing(worker(catalog, scanner));
    const doc = await load(id);
    expect(doc.avStatus).toBe("CLEAN");
    expect(doc.avLastError).toMatch(/ECONNRESET/);
    expect(doc.avNextScanAt!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("a re-scan that finds malware in an ACCEPTED document keeps the review status, blocks the document and asks a human", async () => {
    const catalog = await setup();
    const id = await document(catalog, "VIRUS found later", { avStatus: "CLEAN", status: "ACCEPTED", scannedDaysAgo: 45 });
    await worker(catalog, new FakeScanner()).runOnce();
    const doc = await load(id);
    expect(doc.avStatus).toBe("INFECTED");
    expect(doc.status).toBe("ACCEPTED");
    const quarantine = await client.operatorCase.findFirstOrThrow({ where: { subjectKey: `kyb-infected:${id}` } });
    expect(quarantine.resolutionNotes).toMatch(/on a re-scan/);
    expect(quarantine.resolutionNotes).toMatch(/ACCEPTED/);
    expect(await audits(id, "KYB_DOCUMENT_QUARANTINED")).toBe(1);
    // an accepted document is not rejected, so the merchant gets no "replace it" notice from the scan
    expect(await client.notification.count({ where: { eventId: { startsWith: `notice:kyb-quarantined:${id}` } } })).toBe(0);
  });

  test("a verdict never overwrites a document that changed while it was being scanned", async () => {
    const catalog = await setup();
    const scanner = new FakeScanner();
    scanner.delayMs = 150;
    const id = await document(catalog, "racing");
    const running = worker(catalog, scanner).runOnce();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await client.kybDocument.update({ where: { id }, data: { avStatus: "INFECTED", status: "REJECTED" } });
    await running;
    const doc = await load(id);
    expect(doc.avStatus).toBe("INFECTED");
    expect(doc.avEngine).toBeNull();
    expect(await audits(id, "KYB_DOCUMENT_SCANNED")).toBe(0);
  });

  test("two nodes claiming at once scan every document exactly once", async () => {
    const catalog = await setup();
    const scanner = new FakeScanner();
    scanner.delayMs = 20;
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) ids.push(await document(catalog, `doc-${index}`));
    await Promise.all([
      worker(catalog, scanner, { batchSize: 5 }).runOnce(),
      worker(catalog, scanner, { batchSize: 5 }).runOnce(),
      worker(catalog, scanner, { batchSize: 5 }).runOnce(),
    ]);
    // 3 nodes x batch 5 = at most 15 claims: every one of the 12 is claimed by exactly one node
    expect(scanner.scanned.length).toBe(12);
    expect(new Set(scanner.scanned).size).toBe(12);
    expect((await client.kybDocument.count({ where: { id: { in: ids }, avStatus: "CLEAN" } }))).toBe(12);
  });

  test("a crashed node's claim is retried after the lease; a live claim is not stolen", async () => {
    const catalog = await setup();
    const scanner = new FakeScanner();
    const id = await document(catalog, "claimed");
    // simulate a claim by a node that died: leased for 5 minutes
    await client.$executeRawUnsafe(`UPDATE kyb_documents SET av_next_scan_at = $2, av_scan_attempts = 1 WHERE id = $1::uuid`, id, new Date(NOW.getTime() + 300_000));
    await worker(catalog, scanner).runOnce();
    expect(scanner.scanned).toEqual([]);
    await worker(catalog, scanner, { clock: () => new Date(NOW.getTime() + 301_000) }).runOnce();
    expect(scanner.scanned).toEqual(["claimed"]);
    expect((await load(id)).avStatus).toBe("CLEAN");
  });

  test("without a configured scanner every document stays PENDING and nothing is written", async () => {
    const catalog = await setup();
    const id = await document(catalog, "nobody scans me");
    await worker(catalog, null).runOnce();
    const doc = await load(id);
    expect(doc.avStatus).toBe("PENDING");
    expect(doc.avScanAttempts).toBe(0);
    expect(doc.avNextScanAt).toBeNull();
  });

  test("the scope filter confines a worker to its merchants", async () => {
    const mine = await setup();
    const other = await setup();
    const scanner = new FakeScanner();
    const mineId = await document(mine, "mine");
    const otherId = await document(other, "theirs");
    await worker(mine, scanner).runOnce();
    expect((await load(mineId)).avStatus).toBe("CLEAN");
    expect((await load(otherId)).avStatus).toBe("PENDING");
  });

  test("the backlog monitor check reports old PENDING uploads and ignores fresh, decided and scanned ones", async () => {
    const catalog = await setup();
    await document(catalog, "waiting");
    await document(catalog, "scanned", { avStatus: "CLEAN" });
    await document(catalog, "rejected", { status: "REJECTED" });
    const check = kybScanBacklogCheck({ maxAgeMs: 1_800_000 });
    const findings = (await check.run({ db: client as never, now: NOW } as never)) as Array<{ priority: string; detail: string }>;
    expect(findings).toHaveLength(1);
    expect(findings[0]!.priority).toBe("P2");
    expect(findings[0]!.detail).toMatch(/PENDING for more than/);
    // with a limit longer than the age of any seeded document nothing is reported for this merchant's documents
    const quiet2 = (await kybScanBacklogCheck({ maxAgeMs: 400 * DAY }).run({ db: client as never, now: NOW } as never)) as unknown[];
    expect(quiet2).toHaveLength(0);
  });
});
