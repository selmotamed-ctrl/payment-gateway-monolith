import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PrismaClient } from "../generated/prisma/client";
import {
  createObjectStorageSdk,
  decryptPgos1ToBuffer,
  encryptBufferToPgos1,
  FsBlobStore,
  InMemoryKeyProvider,
  ObjectStorageError,
  RemoteMtlsBlobStore,
  type ObjectStorageSdk,
  type StorageActorContext,
  type StorageBucketTier,
  type StorageErrorCode,
} from "../lib/objectStorageSdk";
import { createObjectStorageWorkers } from "../engine/workers/ObjectStorageWorkers";
import {
  createPrisma,
  databaseIsReachable,
  DATABASE_URL,
  uniqueId,
  uniqueUuid,
} from "./storage-engine/helpers/db";
import { Pool } from "pg";
import { startObjectStorageDaemon } from "../../deploy/object-storage-daemon/src/server";

const describeDatabase = databaseIsReachable ? describe : describe.skip;

const pdf = (marker = "object storage engine"): Buffer =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Size 4/Root 1 0 R>>\n% ${marker}\n%%EOF\n`,
    "utf8",
  );

const png = (marker = "object storage engine"): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`\n% ${marker}\n`, "utf8"),
    Buffer.alloc(64, 0x41),
  ]);

const bigPng = (): Buffer => {
  const header = png("multi-chunk");
  const body = Buffer.alloc(70 * 1024, 0x41);
  return Buffer.concat([header, body]);
};

const bigPdf = (): Buffer => {
  const header = pdf("multi-chunk");
  const body = Buffer.alloc(70 * 1024, 0x41);
  return Buffer.concat([header, body]);
};

const svg = (body: string): Buffer => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`, "utf8");

const keyring = (): InMemoryKeyProvider =>
  new InMemoryKeyProvider({
    activeVersion: 1,
    keysByVersion: new Map([[1, createHash("sha256").update("object-storage-test-key").digest()]]),
  });

const actor = (overrides: Partial<StorageActorContext> = {}): StorageActorContext => ({
  actorType: "ADMIN",
  actorId: "test-admin",
  authorities: ["*"],
  ...overrides,
});

const merchantActor = (merchantId: string): StorageActorContext =>
  actor({
    actorType: "MERCHANT_USER",
    actorId: `merchant-user-${merchantId}`,
    merchantId,
    authorities: ["kyb:read", "disputes:read", "reports:read", "reports.studio.read"],
  });

const expectRejects = async (fn: () => Promise<unknown>, pattern: RegExp): Promise<void> => {
  await expect((async () => { await fn(); })()).rejects.toThrow(pattern);
};

const expectStorageError = async (run: Promise<unknown>, code: StorageErrorCode): Promise<void> => {
  let error: unknown;
  try {
    await run;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ObjectStorageError);
  expect((error as ObjectStorageError).code).toBe(code);
};

describe("pgos1 envelope (database-free)", () => {
  test("round-trips multi-chunk bytes and verifies the SHA-256", () => {
    const provider = keyring();
    const objectId = randomUUID();
    const payload = bigPdf();
    const encrypted = encryptBufferToPgos1(payload, objectId, provider, 16 * 1024);
    expect(encrypted.chunkCount).toBe(Math.ceil(payload.byteLength / (16 * 1024)));
    const decrypted = decryptPgos1ToBuffer({
      ciphertext: encrypted.ciphertextBytes,
      objectId,
      kekKeyVersion: encrypted.kekKeyVersion,
      wrappedDek: encrypted.wrappedDek,
      dekNonce: encrypted.dekNonce,
      streamNoncePrefix: encrypted.streamNoncePrefix,
      expectedChunkCount: encrypted.chunkCount,
      expectedByteSize: encrypted.plaintextByteSize,
      expectedSha256Hex: encrypted.plaintextSha256Hex,
      keyProvider: provider,
    });
    expect(decrypted.equals(payload)).toBe(true);
  });

  test("rejects an empty payload", () => {
    expect(() => encryptBufferToPgos1(new Uint8Array(0), randomUUID(), keyring())).toThrow(/0-byte/);
  });

  test("rejects a bit flip, a truncation and a cross-object ciphertext", () => {
    const provider = keyring();
    const objectId = randomUUID();
    const otherId = randomUUID();
    const payload = bigPdf();
    const encrypted = encryptBufferToPgos1(payload, objectId, provider, 16 * 1024);
    const tampered = Buffer.from(encrypted.ciphertextBytes);
    tampered[10] = tampered[10]! ^ 0x01;
    const params = {
      objectId,
      kekKeyVersion: encrypted.kekKeyVersion,
      wrappedDek: encrypted.wrappedDek,
      dekNonce: encrypted.dekNonce,
      streamNoncePrefix: encrypted.streamNoncePrefix,
      expectedChunkCount: encrypted.chunkCount,
      expectedByteSize: encrypted.plaintextByteSize,
      expectedSha256Hex: encrypted.plaintextSha256Hex,
      keyProvider: provider,
    };
    expect(() => decryptPgos1ToBuffer({ ...params, ciphertext: tampered })).toThrow(/authentication failed/);
    expect(() => decryptPgos1ToBuffer({ ...params, ciphertext: encrypted.ciphertextBytes.subarray(0, encrypted.ciphertextBytes.byteLength - 1) })).toThrow(/Truncated|authentication/);
    expect(() => decryptPgos1ToBuffer({ ...params, ciphertext: encrypted.ciphertextBytes, objectId: otherId })).toThrow(/authentication/);
  });
});

describeDatabase("object storage engine (live PostgreSQL)", () => {
  let prisma: PrismaClient;
  let root: string;
  let blobStore: FsBlobStore;
  let sdk: ObjectStorageSdk;
  let sql: Pool;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "pg-object-storage-test-"));
    prisma = createPrisma();
    blobStore = new FsBlobStore(root);
    sdk = createObjectStorageSdk({ prisma, blobStore, keyProvider: keyring(), gcGraceHours: 24 });
    sql = new Pool({ connectionString: DATABASE_URL, max: 2 });
  });

  afterAll(async () => {
    await sql.end().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  const stage = async (
    namespace: Parameters<ObjectStorageSdk["routeClient"]["stageUpload"]>[0]["namespace"],
    data: Buffer,
    options: { ownerMerchantId?: string | null; actor?: StorageActorContext; filename?: string } = {},
  ) =>
    sdk.routeClient.stageUpload({
      namespace,
      data,
      originalFilename: options.filename ?? "test.bin",
      ownerMerchantId: options.ownerMerchantId ?? null,
      actor: options.actor ?? actor(),
      metadata: { test: true },
    });

  const bindActive = async (
    staged: Awaited<ReturnType<typeof stage>>,
    holderType: Parameters<ObjectStorageSdk["routeClient"]["bind"]>[1]["holderType"] = "CATALOG_ASSET",
    holderId: string = uniqueUuid(),
  ): Promise<string> => {
    await prisma.$transaction(async (tx) => {
      await sdk.routeClient.bind(tx, {
        objectId: staged.objectId,
        holderType,
        holderId,
        actorId: "test-admin",
        reason: "TEST_BIND",
      });
    });
    return holderId;
  };

  const hotPath = (staged: { storageKey: string }): string => path.join(root, "hot", staged.storageKey);

  const expectSqlRejects = async (statement: string, values: unknown[], pattern: RegExp): Promise<void> => {
    let error: unknown;
    try {
      await sql.query(statement, values);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(pattern);
  };

  test("T01 stage, bind, promote and read round-trip", async () => {
    const payload = png("t01");
    const staged = await stage("REPORT_STUDIO_ASSETS", payload);
    const holderId = await bindActive(staged);
    expect(staged.detectedMimeType).toBe("image/png");
    const object = await prisma.storageObject.findUniqueOrThrow({ where: { id: staged.objectId } });
    expect(object.status).toBe("ACTIVE");
    expect(object.retainUntil).not.toBeNull();
    const read = await sdk.routeClient.readAuthorized({
      objectId: staged.objectId,
      actor: actor(),
      holderContext: { holderType: "CATALOG_ASSET", holderId },
    });
    expect(Buffer.from(read.bytes).equals(payload)).toBe(true);
    expect(read.sha256Hex).toBe(createHash("sha256").update(payload).digest("hex"));
    const logs = await prisma.storageObjectAccessLog.findMany({ where: { objectId: staged.objectId } });
    expect(logs.some((log) => log.action === "READ_AUTHORIZED" && log.allowed)).toBe(true);
  });

  test("T02 a single-bit tamper is detected by GCM", async () => {
    const staged = await stage("REPORT_STUDIO_ASSETS", png("t02"));
    const holderId = await bindActive(staged);
    const file = await fsp.readFile(hotPath(staged));
    file[Math.min(40, file.byteLength - 1)] = file[Math.min(40, file.byteLength - 1)]! ^ 0x01;
    await fsp.writeFile(hotPath(staged), file);
    await expectStorageError(
      sdk.routeClient.readAuthorized({
        objectId: staged.objectId,
        actor: actor(),
        holderContext: { holderType: "CATALOG_ASSET", holderId },
      }),
      "STORAGE_INTEGRITY_CORRUPTED",
    );
  });

  test("T03 truncation and chunk reordering are detected", async () => {
    const staged = await stage("REPORT_STUDIO_ASSETS", bigPng());
    const holderId = await bindActive(staged);
    const ciphertext = await fsp.readFile(hotPath(staged));
    // Truncate the last byte.
    const truncated = ciphertext.subarray(0, ciphertext.byteLength - 1);
    await fsp.writeFile(hotPath(staged), truncated);
    await expectStorageError(
      sdk.routeClient.readAuthorized({ objectId: staged.objectId, actor: actor(), holderContext: { holderType: "CATALOG_ASSET", holderId } }),
      "STORAGE_INTEGRITY_CORRUPTED",
    );
    // Rebuild the original and swap the first two frames (the AAD binds the index).
    const object = await prisma.storageObject.findUniqueOrThrow({ where: { id: staged.objectId } });
    const plaintextChunk = 64 * 1024;
    // Re-encrypt to get a known layout, then swap the two ciphertext frames.
    const original = encryptBufferToPgos1(bigPng(), staged.objectId, keyring(), plaintextChunk);
    // The stored object used a different DEK; a swap of its raw frames is enough.
    const magic = 5;
    const frameSize = 4 + plaintextChunk + 16;
    const first = ciphertext.subarray(magic, magic + frameSize);
    const second = ciphertext.subarray(magic + frameSize, magic + frameSize * 2);
    const swapped = Buffer.concat([ciphertext.subarray(0, magic), second, first, ciphertext.subarray(magic + frameSize * 2)]);
    await fsp.writeFile(hotPath(staged), swapped);
    void original;
    void object;
    await expectStorageError(
      sdk.routeClient.readAuthorized({ objectId: staged.objectId, actor: actor(), holderContext: { holderType: "CATALOG_ASSET", holderId } }),
      "STORAGE_INTEGRITY_CORRUPTED",
    );
  });

  test("T04 a blob swapped between objects fails decryption", async () => {
    const a = await stage("REPORT_STUDIO_ASSETS", png("object-a"));
    const b = await stage("REPORT_STUDIO_ASSETS", png("object-b"));
    const holderA = await bindActive(a);
    await bindActive(b);
    await fsp.copyFile(hotPath(b), hotPath(a));
    await expectStorageError(
      sdk.routeClient.readAuthorized({ objectId: a.objectId, actor: actor(), holderContext: { holderType: "CATALOG_ASSET", holderId: holderA } }),
      "STORAGE_INTEGRITY_CORRUPTED",
    );
  });

  test("T05 withStagedUpload discards a staged blob when the caller rolls back", async () => {
    const payload = png("t05");
    let objectId = "";
    await expect(
      sdk.routeClient.withStagedUpload(
        { namespace: "REPORT_STUDIO_ASSETS", data: payload, actor: actor(), originalFilename: "rollback.pdf" },
        async (staged) => {
          objectId = staged.objectId;
          throw new Error("caller rolled back");
        },
      ),
    ).rejects.toThrow("caller rolled back");
    const row = await prisma.storageObject.findUniqueOrThrow({ where: { id: objectId } });
    expect(row.status).toBe("PURGED");
    const trash = await fsp.readdir(path.join(root, ".trash"));
    expect(trash.length).toBeGreaterThan(0);
  });

  test("T06 direct SQL delete is blocked by the trigger", async () => {
    const staged = await stage("REPORT_STUDIO_ASSETS", png("t06"));
    await bindActive(staged);
    await expectSqlRejects("DELETE FROM storage_objects WHERE id = $1", [staged.objectId], /STORAGE_OBJECT_DELETE_FORBIDDEN/);
  });

  test("T07 purge is blocked while an active lock exists", async () => {
    const staged = await stage("REPORT_STUDIO_ASSETS", png("t07"));
    await bindActive(staged);
    await expectSqlRejects(
      "UPDATE storage_objects SET status = 'PURGED', purged_at = NOW() WHERE id = $1",
      [staged.objectId],
      /STORAGE_OBJECT_LOCKED/,
    );
  });

  test("T08 shared multi-holder lock ref counting", async () => {
    const staged = await stage("SYSTEM_BRAND_ASSETS", png("t08"));
    const catalogHolder = uniqueUuid();
    const railHolder = uniqueUuid();
    await prisma.$transaction(async (tx) => {
      await sdk.routeClient.bind(tx, { objectId: staged.objectId, holderType: "CATALOG_ASSET", holderId: catalogHolder, actorId: "test", reason: "T08" });
      await sdk.routeClient.bind(tx, { objectId: staged.objectId, holderType: "RAIL_LOGO", holderId: railHolder, actorId: "test", reason: "T08" });
    });
    const first = await prisma.$transaction(async (tx) =>
      sdk.routeClient.release(tx, { objectId: staged.objectId, holderType: "CATALOG_ASSET", holderId: catalogHolder, actorId: "test", reason: "T08" }),
    );
    expect(first.remainingActiveLocks).toBe(1);
    const stillActive = await prisma.storageObject.findUniqueOrThrow({ where: { id: staged.objectId } });
    expect(stillActive.gcEligibleAt).toBeNull();
    const second = await prisma.$transaction(async (tx) =>
      sdk.routeClient.release(tx, { objectId: staged.objectId, holderType: "RAIL_LOGO", holderId: railHolder, actorId: "test", reason: "T08" }),
    );
    expect(second.remainingActiveLocks).toBe(0);
    const eligible = await prisma.storageObject.findUniqueOrThrow({ where: { id: staged.objectId } });
    expect(eligible.gcEligibleAt).not.toBeNull();
  });

  test("T09 retention blocks an early purge and shortening", async () => {
    const staged = await stage("SYSTEM_BRAND_ASSETS", png("t09"));
    await bindActive(staged);
    await expectSqlRejects(
      "UPDATE storage_objects SET status = 'PURGED', purged_at = NOW() WHERE id = $1",
      [staged.objectId],
      /STORAGE_OBJECT_LOCKED|STORAGE_OBJECT_RETENTION_ACTIVE/,
    );
    // Release the lock and retry with the retention still active.
    const locks = await prisma.storageObjectLock.findMany({ where: { objectId: staged.objectId, releasedAt: null } });
    for (const lock of locks) {
      await prisma.$transaction(async (tx) =>
        sdk.routeClient.release(tx, { objectId: staged.objectId, holderType: lock.holderType as never, holderId: lock.holderId, actorId: "test", reason: "T09" }),
      );
    }
    await expectSqlRejects(
      "UPDATE storage_objects SET status = 'PURGED', purged_at = NOW() WHERE id = $1",
      [staged.objectId],
      /STORAGE_OBJECT_RETENTION_ACTIVE/,
    );
    await expectSqlRejects(
      "UPDATE storage_objects SET retain_until = NOW() + INTERVAL '60 seconds' WHERE id = $1",
      [staged.objectId],
      /STORAGE_OBJECT_RETENTION_SHORTEN_FORBIDDEN/,
    );
  });

  test("T10 a legal hold blocks GC and purge", async () => {
    const staged = await stage("SYSTEM_BRAND_ASSETS", png("t10"));
    const holderId = await bindActive(staged);
    await prisma.$transaction(async (tx) =>
      sdk.routeClient.release(tx, { objectId: staged.objectId, holderType: "CATALOG_ASSET", holderId, actorId: "test", reason: "T10" }),
    );
    const held = await sdk.routeClient.placeLegalHold({ objectId: staged.objectId, adminId: uniqueUuid(), reason: "Investigation reference T10" });
    expect(held.legalHold).toBe(true);
    const before = await prisma.storageObject.findUniqueOrThrow({ where: { id: staged.objectId } });
    await sdk.workerClient.runGcBatch(new Date(Date.now() + 400 * 24 * 3600 * 1000));
    const after = await prisma.storageObject.findUniqueOrThrow({ where: { id: staged.objectId } });
    expect(after.status).toBe("ACTIVE");
    void before;
    await expectSqlRejects(
      "UPDATE storage_objects SET status = 'PURGED', purged_at = NOW() WHERE id = $1",
      [staged.objectId],
      /STORAGE_OBJECT_LEGAL_HOLD_ACTIVE/,
    );
  });

  test("T11 a KYB object is quarantined with null retention and cannot be read", async () => {
    const staged = await stage("KYB_DOCUMENTS", pdf("t11"), { actor: merchantActor(uniqueUuid()) });
    const holderId = uniqueUuid();
    await prisma.$transaction(async (tx) => {
      await sdk.routeClient.bind(tx, {
        objectId: staged.objectId,
        holderType: "KYB_DOCUMENT",
        holderId,
        actorId: "test",
        reason: "T11",
        autoPromoteIfNoAvRequired: false,
      });
    });
    const object = await prisma.storageObject.findUniqueOrThrow({ where: { id: staged.objectId } });
    expect(object.status).toBe("QUARANTINE_PENDING_AV");
    expect(object.retainUntil).toBeNull();
    await expectStorageError(
      sdk.routeClient.readAuthorized({ objectId: staged.objectId, actor: actor(), holderContext: { holderType: "KYB_DOCUMENT", holderId } }),
      "STORAGE_OBJECT_QUARANTINED",
    );
  });

  test("T12 an infected verdict releases locks and rejects the object", async () => {
    const staged = await stage("KYB_DOCUMENTS", pdf("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"), { actor: merchantActor(uniqueUuid()) });
    const holderId = uniqueUuid();
    await prisma.$transaction(async (tx) => {
      await sdk.routeClient.bind(tx, {
        objectId: staged.objectId,
        holderType: "KYB_DOCUMENT",
        holderId,
        actorId: "test",
        reason: "T12",
        autoPromoteIfNoAvRequired: false,
      });
    });
    await sdk.workerClient.applyScanVerdict({ objectId: staged.objectId, verdict: "INFECTED", signature: "EICAR-Test-Signature" });
    const object = await prisma.storageObject.findUniqueOrThrow({ where: { id: staged.objectId } });
    expect(object.status).toBe("QUARANTINE_REJECTED");
    expect(object.avScanStatus).toBe("INFECTED");
    expect(object.retainUntil).toBeNull();
    const activeLocks = await prisma.storageObjectLock.count({ where: { objectId: staged.objectId, releasedAt: null } });
    expect(activeLocks).toBe(0);
  });

  test("T13 active-content SVG uploads are rejected", async () => {
    for (const payload of [
      svg('<script>alert(1)</script>'),
      svg('<image href="x" onload="alert(1)"/>'),
      svg('<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject>'),
    ]) {
      await expect(stage("REPORT_STUDIO_ASSETS", payload)).rejects.toMatchObject({ code: "STORAGE_SVG_UNSAFE" });
    }
  });

  test("T14 executable bytes spoofed as a PDF are rejected", async () => {
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]);
    await expect(
      sdk.routeClient.stageUpload({
        namespace: "REPORT_STUDIO_ASSETS",
        data: elf,
        originalFilename: "invoice.pdf",
        claimedMimeType: "application/pdf",
        actor: actor(),
      }),
    ).rejects.toMatchObject({ code: "STORAGE_MIME_FORBIDDEN" });
  });

  test("T15 merchant cross-tenant reads are denied and logged", async () => {
    const owner = uniqueUuid();
    const staged = await stage("KYB_DOCUMENTS", pdf("t15"), { ownerMerchantId: owner, actor: merchantActor(owner) });
    const holderId = uniqueUuid();
    await prisma.$transaction(async (tx) => {
      await sdk.routeClient.bind(tx, {
        objectId: staged.objectId,
        holderType: "KYB_DOCUMENT",
        holderId,
        actorId: "test",
        reason: "T15",
        autoPromoteIfNoAvRequired: false,
      });
    });
    await sdk.workerClient.applyScanVerdict({ objectId: staged.objectId, verdict: "CLEAN" });
    const other = uniqueUuid();
    await expectStorageError(
      sdk.routeClient.readAuthorized({
        objectId: staged.objectId,
        actor: merchantActor(other),
        holderContext: { holderType: "KYB_DOCUMENT", holderId },
      }),
      "STORAGE_TENANT_MISMATCH",
    );
    const denied = await prisma.storageObjectAccessLog.findMany({ where: { objectId: staged.objectId, action: "READ_DENIED_TENANT_MISMATCH" } });
    expect(denied.length).toBeGreaterThan(0);
  });

  test("T16 an admin without the required authority is denied", async () => {
    const staged = await stage("REGULATORY_REPORTS", pdf("t16"));
    const holderId = await bindActive(staged, "REG_REPORT_OUTPUT");
    await expectStorageError(
      sdk.routeClient.readAuthorized({
        objectId: staged.objectId,
        actor: actor({ authorities: ["gateway:read"] }),
        holderContext: { holderType: "REG_REPORT_OUTPUT", holderId },
      }),
      "STORAGE_ACCESS_DENIED",
    );
    const denied = await prisma.storageObjectAccessLog.findMany({ where: { objectId: staged.objectId, action: "READ_DENIED_AUTHORITY" } });
    expect(denied.length).toBeGreaterThan(0);
  });

  test("T17 KEK rewrap changes the DB version without rewriting the blob", async () => {
    const firstProvider = keyring();
    const rewrapSdk = createObjectStorageSdk({ prisma, blobStore, keyProvider: firstProvider });
    const staged = await rewrapSdk.routeClient.stageUpload({
      namespace: "REPORT_STUDIO_ASSETS",
      data: png("t17"),
      actor: actor(),
      originalFilename: "t17.pdf",
    });
    const holderId = await bindActive(staged);
    const before = await fsp.stat(hotPath(staged));
    const secondProvider = new InMemoryKeyProvider({
      activeVersion: 2,
      keysByVersion: new Map([
        [1, createHash("sha256").update("object-storage-test-key").digest()],
        [2, createHash("sha256").update("object-storage-test-key-v2").digest()],
      ]),
    });
    const v2Sdk = createObjectStorageSdk({ prisma, blobStore, keyProvider: secondProvider });
    const result = await v2Sdk.workerClient.runRewrapBatch(1000);
    expect(result.targetVersion).toBe(2);
    const row = await prisma.storageObject.findUniqueOrThrow({ where: { id: staged.objectId } });
    expect(row.kekKeyVersion).toBe(2);
    const after = await fsp.stat(hotPath(staged));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const read = await v2Sdk.routeClient.readAuthorized({
      objectId: staged.objectId,
      actor: actor(),
      holderContext: { holderType: "CATALOG_ASSET", holderId },
    });
    expect(Buffer.from(read.bytes).equals(png("t17"))).toBe(true);
  });

  test("T18 GC grace window moves the blob to soft trash", async () => {
    // A synthetic ACTIVE row with no retention and an elapsed GC window (the
    // lock-release grace stamp itself is asserted in T08).
    const objectId = uniqueUuid();
    const storageKey = `synthetic/${objectId}.v1.enc`;
    const bytes = Buffer.from("deadbeef", "hex");
    await fsp.mkdir(path.dirname(path.join(root, "hot", storageKey)), { recursive: true });
    await fsp.writeFile(path.join(root, "hot", storageKey), bytes);
    await prisma.storageObject.create({
      data: {
        id: objectId,
        bucket: "HOT",
        namespace: "SYSTEM_BRAND_ASSETS",
        storageKey,
        status: "ACTIVE",
        sha256Hex: createHash("sha256").update("t18").digest("hex"),
        byteSize: BigInt(bytes.byteLength),
        chunkSizeBytes: 65536,
        chunkCount: 1,
        detectedMimeType: "image/png",
        wrappedDek: new Uint8Array(48),
        dekNonce: new Uint8Array(12),
        streamNoncePrefix: new Uint8Array(7),
        uploadedByActorType: "SYSTEM_WORKER",
        uploadedByActorId: "test",
        requiredAuthority: "system:assets:read",
        confidentialityTier: "PUBLIC_BRAND",
        retainUntil: null,
        gcEligibleAt: new Date(Date.now() - 1000),
        stagingExpiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const result = await sdk.workerClient.runGcBatch(new Date(Date.now() + 2 * 24 * 3600 * 1000));
    expect(result.purgedObjectIds).toContain(objectId);
    const row = await prisma.storageObject.findUniqueOrThrow({ where: { id: objectId } });
    expect(row.status).toBe("PURGED");
    const trashFolders = await fsp.readdir(path.join(root, ".trash"));
    expect(trashFolders.length).toBeGreaterThan(0);
    const trashed = await fsp.readdir(path.join(root, ".trash", trashFolders[0]!, "hot", path.dirname(storageKey)), { recursive: true });
    expect(trashed.length).toBeGreaterThan(0);
  });

  test("T19 the lock reconciler releases a lock whose domain row is gone", async () => {
    const staged = await stage("SYSTEM_BRAND_ASSETS", png("t19"));
    const assetId = uniqueUuid();
    const assetName = uniqueId("t19-asset");
    await prisma.asset.create({
      data: {
        id: assetId,
        name: assetName,
        mime: "IMAGE_PNG",
        sizeBytes: 1,
        storageKey: staged.storageKey,
        storageObjectId: staged.objectId,
        sha256: createHash("sha256").update(assetName).digest("hex"),
      },
    });
    await prisma.$transaction(async (tx) => {
      await sdk.routeClient.bind(tx, { objectId: staged.objectId, holderType: "CATALOG_ASSET", holderId: assetId, actorId: "test", reason: "T19" });
    });
    // The reconciler sees the missing holder and releases the lock.
    await prisma.asset.delete({ where: { id: assetId } });
    const reconciled = await sdk.workerClient.runLockReconcile();
    expect(reconciled.releasedDanglingLocks).toBeGreaterThanOrEqual(1);
    const lock = await prisma.storageObjectLock.findFirstOrThrow({ where: { objectId: staged.objectId, holderType: "CATALOG_ASSET", holderId: assetId } });
    expect(lock.releasedAt).not.toBeNull();
  });

  test("T20 two nodes read the same object through the shared daemon", async () => {
    const daemonRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "pg-object-daemon-test-"));
    const daemon = await startObjectStorageDaemon({ rootDir: daemonRoot, port: 0, bindHost: "127.0.0.1", requireMtls: false } as never);
    try {
      const node1 = createObjectStorageSdk({
        prisma,
        blobStore: new RemoteMtlsBlobStore({ baseUrl: daemon.baseUrl }),
        keyProvider: keyring(),
      });
      const node2 = createObjectStorageSdk({
        prisma,
        blobStore: new RemoteMtlsBlobStore({ baseUrl: daemon.baseUrl }),
        keyProvider: keyring(),
      });
      const staged = await node1.routeClient.stageUpload({
        namespace: "REPORT_STUDIO_ASSETS",
        data: png("t20"),
        actor: actor(),
        originalFilename: "shared.pdf",
      });
      const holderId = uniqueUuid();
      await prisma.$transaction(async (tx) => {
        await node1.routeClient.bind(tx, { objectId: staged.objectId, holderType: "CATALOG_ASSET", holderId, actorId: "node-1", reason: "T20" });
      });
      const read = await node2.routeClient.readAuthorized({
        objectId: staged.objectId,
        actor: actor(),
        holderContext: { holderType: "CATALOG_ASSET", holderId },
      });
      expect(Buffer.from(read.bytes).equals(png("t20"))).toBe(true);
      const health = await node2.blobStore.healthCheck();
      expect(health.ok).toBe(true);
      expect(health.mode).toBe("REMOTE_MTLS");
    } finally {
      await daemon.close();
      await fsp.rm(daemonRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("T22 backup parity, KEK escrow and drill decryption", async () => {
    // Covered end-to-end in deploy/test/objectStorageDeploy.test.ts with a
    // real artifact repository; here we prove the escrow envelope round-trip.
    const { sealKekEscrow, openKekEscrow } = await import("../../deploy/backup-daemon/src/objectStorageBackup");
    const master = "a".repeat(64);
    const keyringJson = JSON.stringify({ activeVersion: 1, keys: { "1": "b".repeat(64) } });
    const sealed = sealKekEscrow(master, keyringJson);
    expect(openKekEscrow(master, sealed)).toBe(keyringJson);
    expect(() => openKekEscrow("c".repeat(64), sealed)).toThrow();
  });
});

describe("generic quarantine scanner (database-free helper wiring)", () => {
  test("unreadable objects stay pending instead of being promoted", async () => {
    // createObjectStorageWorkers is exercised with a fake SDK that cannot read;
    // the object must not be marked clean.
    const calls: unknown[] = [];
    const sdk = {
      workerClient: {
        readForScan: async () => {
          throw new Error("vault unavailable");
        },
        applyScanVerdict: async (input: unknown) => {
          calls.push(input);
        },
      },
    } as unknown as ObjectStorageSdk;
    const prisma = {
      storageObject: {
        findMany: async () => [{ id: uniqueUuid(), bucket: "HOT", storageKey: "x" }],
      },
    } as unknown as PrismaClient;
    const workers = createObjectStorageWorkers({ sdk, prisma });
    const result = await workers.runAvScanBatch(10);
    expect(result.scanned).toBe(1);
    expect(result.clean).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
