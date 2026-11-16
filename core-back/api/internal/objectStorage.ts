import express, { type Request, type Response } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { writeAudit } from "../../lib/audit/writeAudit";
import { BlobStoreUnavailableError, ObjectStorageError } from "../../lib/objectStorageSdk";
import { getObjectStorageSdk } from "../../lib/objectStorageSdk/runtime";
import { createObjectStorageWorkers } from "../../engine/workers/ObjectStorageWorkers";

/**
 * The admin console API of the Shared Object & Asset Storage Engine.
 *
 * Every response is control-plane metadata only: the wrapped DEKs, nonces and
 * plaintext bytes never leave the vault through this surface. Downloads stay
 * on the domain routes, which enforce the object's holder and authority.
 */

const router = express.Router();

const requireAny = (request: Request, accepted: readonly string[]): void => {
  const principal = request.principal;
  if (!principal) throw new ApiError(401, "AUTH_REQUIRED", "An authenticated staff principal is required");
  if (principal.authorities.includes("*")) return;
  if (!accepted.some((authority) => principal.authorities.includes(authority))) {
    throw new ApiError(403, "AUTHORITY_REQUIRED", `One of ${accepted.join(", ")} is required`);
  }
};

const actorOf = (request: Request): { userId: string; role: string } => {
  const principal = request.principal;
  if (!principal?.userId) throw new ApiError(401, "AUTH_REQUIRED", "An authenticated staff principal is required");
  return { userId: principal.userId, role: principal.role ?? "UNKNOWN" };
};

const asApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;
  if (error instanceof ObjectStorageError) {
    return new ApiError(error.httpStatus, error.code, error.message);
  }
  if (error instanceof BlobStoreUnavailableError) {
    return new ApiError(error.httpStatus, error.code, error.message);
  }
  // Do not echo Prisma/SQL messages to a console user; log server-side only.
  return new ApiError(500, "OBJECT_STORAGE_ERROR", "The object-storage operation failed");
};

const handler = (fn: (request: Request, response: Response) => Promise<void>) =>
  async (request: Request, response: Response): Promise<void> => {
    try {
      await fn(request, response);
    } catch (error) {
      throw asApiError(error);
    }
  };

const safeObjectRow = (row: Record<string, any>) => ({
  id: row.id,
  bucket: row.bucket,
  namespace: row.namespace,
  storageKey: row.storageKey,
  status: row.status,
  sha256Hex: row.sha256Hex,
  byteSize: row.byteSize?.toString?.() ?? String(row.byteSize),
  chunkSizeBytes: row.chunkSizeBytes,
  chunkCount: row.chunkCount,
  detectedMimeType: row.detectedMimeType,
  originalFilename: row.originalFilename,
  ownerMerchantId: row.ownerMerchantId,
  uploadedByActorType: row.uploadedByActorType,
  uploadedByActorId: row.uploadedByActorId,
  requiredAuthority: row.requiredAuthority,
  confidentialityTier: row.confidentialityTier,
  retainUntil: row.retainUntil,
  legalHold: row.legalHold,
  legalHoldReason: row.legalHoldReason,
  legalHoldByAdminId: row.legalHoldByAdminId,
  legalHoldPlacedAt: row.legalHoldPlacedAt,
  gcEligibleAt: row.gcEligibleAt,
  gcClaimedAt: row.gcClaimedAt,
  avScanStatus: row.avScanStatus,
  avScannedAt: row.avScannedAt,
  avSignature: row.avSignature,
  lastScrubbedAt: row.lastScrubbedAt,
  scrubErrorCount: row.scrubErrorCount,
  metadata: row.metadata,
  stagingExpiresAt: row.stagingExpiresAt,
  activatedAt: row.activatedAt,
  purgedAt: row.purgedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const safeLockRow = (row: Record<string, any>) => ({
  id: row.id,
  objectId: row.objectId,
  holderType: row.holderType,
  holderId: row.holderId,
  retentionFloorUntil: row.retentionFloorUntil,
  acquiredByActorId: row.acquiredByActorId,
  acquiredReason: row.acquiredReason,
  acquiredAt: row.acquiredAt,
  releasedAt: row.releasedAt,
  releasedByActorId: row.releasedByActorId,
  releaseReason: row.releaseReason,
});

const safeAccessLogRow = (row: Record<string, any>) => ({
  id: row.id,
  objectId: row.objectId,
  actorType: row.actorType,
  actorId: row.actorId,
  action: row.action,
  allowed: row.allowed,
  denialReason: row.denialReason,
  holderType: row.holderType,
  holderId: row.holderId,
  ipAddress: row.ipAddress,
  requestId: row.requestId,
  bytesServed: row.bytesServed?.toString?.() ?? (row.bytesServed == null ? null : String(row.bytesServed)),
  occurredAt: row.occurredAt,
});

router.get("/summary", handler(async (request, response) => {
  requireAny(request, ["system:storage:read", "system:storage:admin", "system:storage:legal-hold"]);
  const sdk = getObjectStorageSdk();
  const prisma = sdk.prisma;
  const [health, statusRows, namespaceRows, activeLocksCount, legalHoldCount, quarantinePendingCount, scrubErrors, totalObjects] =
    await Promise.all([
      sdk.blobStore.healthCheck(),
      prisma.storageObject.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.storageObject.groupBy({ by: ["namespace"], _sum: { byteSize: true }, _count: { _all: true } }),
      prisma.storageObjectLock.count({ where: { releasedAt: null } }),
      prisma.storageObject.count({ where: { legalHold: true } }),
      prisma.storageObject.count({ where: { status: "QUARANTINE_PENDING_AV" } }),
      prisma.storageObject.aggregate({ where: { status: "ACTIVE", scrubErrorCount: { gt: 0 } }, _sum: { scrubErrorCount: true }, _count: { _all: true } }),
      prisma.storageObject.count(),
    ]);
  const countsByStatus: Record<string, number> = {};
  for (const row of statusRows) countsByStatus[row.status] = row._count._all;
  const bytesByNamespace: Record<string, { objects: number; bytes: string }> = {};
  for (const row of namespaceRows) {
    bytesByNamespace[row.namespace] = {
      objects: row._count._all,
      bytes: (row._sum.byteSize ?? 0n).toString(),
    };
  }
  response.json({
    health,
    activeKekVersion: sdk.keyProvider.getActiveVersion(),
    countsByStatus,
    bytesByNamespace,
    activeLocksCount,
    legalHoldCount,
    quarantinePendingCount,
    scrubErrorsCount: Number(scrubErrors._sum.scrubErrorCount ?? 0),
    scrubErrorObjects: scrubErrors._count._all,
    totalObjects,
  });
}));

const NAMESPACES = [
  "KYB_DOCUMENTS", "RECON_STATEMENTS", "REGULATORY_REPORTS", "REPORT_STUDIO_ASSETS",
  "MERCHANT_STATEMENTS", "DISPUTE_EVIDENCE", "AML_CASE_ATTACHMENTS", "SYSTEM_BRAND_ASSETS", "BACKUP_ARTIFACTS",
] as const;
const STATUSES = ["STAGING", "QUARANTINE_PENDING_AV", "QUARANTINE_REJECTED", "ACTIVE", "PURGED"] as const;
const BUCKETS = ["HOT", "COLD", "QUARANTINE"] as const;
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  namespace: z.enum(NAMESPACES).optional(),
  status: z.enum(STATUSES).optional(),
  statuses: z.string().trim().max(200).optional(),
  bucket: z.enum(BUCKETS).optional(),
  ownerMerchantId: z.string().uuid().optional(),
  legalHold: z.enum(["true", "false"]).optional(),
  sha256Hex: z.string().trim().length(64).regex(/^[a-f0-9]{64}$/i).optional(),
  search: z.string().trim().max(200).optional(),
  sortKey: z.enum(["createdAt", "namespace", "status", "retainUntil", "byteSize", "originalFilename"]).default("createdAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
}).strict();

router.get("/objects", handler(async (request, response) => {
  requireAny(request, ["system:storage:read", "system:storage:admin", "system:storage:legal-hold"]);
  const query = parseOrThrow(listQuery, request.query ?? {});
  const where: Record<string, unknown> = {};
  if (query.namespace) where.namespace = query.namespace;
  if (query.status) where.status = query.status;
  if (query.statuses) {
    const statuses = query.statuses.split(",").map((value) => value.trim()).filter(Boolean);
    const invalid = statuses.find((value) => !STATUSES.includes(value as never));
    if (invalid) throw new ApiError(400, "STORAGE_STATUS_INVALID", `Unknown storage status: ${invalid}`);
    if (statuses.length > 0) where.status = { in: statuses };
  }
  if (query.bucket) where.bucket = query.bucket;
  if (query.ownerMerchantId) where.ownerMerchantId = query.ownerMerchantId;
  if (query.legalHold) where.legalHold = query.legalHold === "true";
  if (query.sha256Hex) where.sha256Hex = query.sha256Hex.toLowerCase();
  if (query.search) {
    const or: Record<string, unknown>[] = [
      { storageKey: { contains: query.search, mode: "insensitive" } },
      { originalFilename: { contains: query.search, mode: "insensitive" } },
    ];
    const uuid = z.string().uuid().safeParse(query.search);
    if (uuid.success) or.push({ id: uuid.data });
    where.OR = or;
  }
  const prisma = getObjectStorageSdk().prisma;
  const [rows, total] = await Promise.all([
    prisma.storageObject.findMany({
      where: where as Prisma.StorageObjectWhereInput,
      orderBy: { [query.sortKey]: query.sortDirection },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { locks: { where: { releasedAt: null } } },
    }),
    prisma.storageObject.count({ where: where as Prisma.StorageObjectWhereInput }),
  ]);
  response.json({
    objects: rows.map((row) => ({ ...safeObjectRow(row as never), activeLocks: (row as never as { locks: unknown[] }).locks.map((lock) => safeLockRow(lock as never)) })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  });
}));

router.get("/objects/:id", handler(async (request, response) => {
  requireAny(request, ["system:storage:read", "system:storage:admin", "system:storage:legal-hold"]);
  const { id } = parseOrThrow(z.object({ id: z.string().uuid() }).strict(), request.params);
  const prisma = getObjectStorageSdk().prisma;
  const row = await prisma.storageObject.findUnique({
    where: { id },
    include: {
      locks: { orderBy: { acquiredAt: "desc" } },
      accessLogs: { orderBy: { occurredAt: "desc" }, take: 50 },
    },
  });
  if (!row) throw new ApiError(404, "STORAGE_OBJECT_NOT_FOUND", "The storage object does not exist");
  response.json({
    object: safeObjectRow(row as never),
    locks: (row as never as { locks: unknown[] }).locks.map((lock) => safeLockRow(lock as never)),
    accessLogs: (row as never as { accessLogs: unknown[] }).accessLogs.map((log) => safeAccessLogRow(log as never)),
  });
}));

router.post("/objects/:id/legal-hold", handler(async (request, response) => {
  requireAny(request, ["system:storage:legal-hold"]);
  const { id } = parseOrThrow(z.object({ id: z.string().uuid() }).strict(), request.params);
  const body = parseOrThrow(z.object({ reason: z.string().trim().min(5).max(512) }).strict(), request.body ?? {});
  const actor = actorOf(request);
  const updated = await getObjectStorageSdk().routeClient.placeLegalHold({ objectId: id, adminId: actor.userId, reason: body.reason });
  await writeAudit(getObjectStorageSdk().prisma, {
    data: {
      actorId: actor.userId,
      role: actor.role,
      action: "STORAGE_LEGAL_HOLD_PLACED",
      entityType: "STORAGE_OBJECT",
      entityId: id,
      beforeJson: {},
      afterJson: { reason: body.reason, retainUntil: updated.retainUntil?.toISOString() ?? null },
    },
  });
  response.json({ object: safeObjectRow(updated as never) });
}));

router.delete("/objects/:id/legal-hold", handler(async (request, response) => {
  requireAny(request, ["system:storage:legal-hold"]);
  const { id } = parseOrThrow(z.object({ id: z.string().uuid() }).strict(), request.params);
  const body = parseOrThrow(z.object({ reason: z.string().trim().min(5).max(512) }).strict(), request.body ?? {});
  const actor = actorOf(request);
  const sdk = getObjectStorageSdk();
  // Lifting a hold is a sensitive, loosening action: the maker proposes and a
  // different checker approves. Placing a hold stays immediate.
  const existing = await sdk.prisma.approvalRequest.findFirst({
    where: { subjectType: "STORAGE_LEGAL_HOLD", subjectId: id, state: "PENDING_REVIEW" },
    orderBy: { createdAt: "desc" },
  });
  const approval = existing ?? await sdk.prisma.approvalRequest.create({
    data: {
      subjectType: "STORAGE_LEGAL_HOLD",
      subjectId: id,
      payloadDiffJson: { action: "LIFT", reason: body.reason } as Prisma.InputJsonValue,
      makerReason: body.reason,
      mode: "STANDARD",
      makerUserId: actor.userId,
      state: "PENDING_REVIEW",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  await writeAudit(sdk.prisma, {
    data: {
      actorId: actor.userId,
      role: actor.role,
      action: "STORAGE_LEGAL_HOLD_LIFT_REQUESTED",
      entityType: "STORAGE_OBJECT",
      entityId: id,
      beforeJson: { legalHold: true },
      afterJson: { legalHold: true, approvalRequestId: approval.id, reason: body.reason },
    },
  });
  response.status(202).json({ status: "PENDING_CHECKER", approvalRequestId: approval.id });
}));

const accessLogQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  allowed: z.enum(["true", "false"]).optional(),
  action: z.string().trim().max(48).optional(),
  objectId: z.string().uuid().optional(),
  search: z.string().trim().max(200).optional(),
}).strict();

router.get("/access-logs", handler(async (request, response) => {
  requireAny(request, ["system:storage:read", "system:storage:admin", "system:storage:legal-hold"]);
  const query = parseOrThrow(accessLogQuery, request.query ?? {});
  const where: Record<string, unknown> = {};
  if (query.allowed) where.allowed = query.allowed === "true";
  if (query.action) where.action = query.action;
  if (query.objectId) where.objectId = query.objectId;
  if (query.search) {
    where.OR = [
      { actorId: { contains: query.search, mode: "insensitive" } },
      { requestId: { contains: query.search, mode: "insensitive" } },
      { denialReason: { contains: query.search, mode: "insensitive" } },
    ];
  }
  const prisma = getObjectStorageSdk().prisma;
  const [rows, total] = await Promise.all([
    prisma.storageObjectAccessLog.findMany({
      where: where as Prisma.StorageObjectAccessLogWhereInput,
      orderBy: { occurredAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { object: { select: { id: true, namespace: true, storageKey: true, detectedMimeType: true } } },
    }),
    prisma.storageObjectAccessLog.count({ where: where as Prisma.StorageObjectAccessLogWhereInput }),
  ]);
  response.json({
    accessLogs: rows.map((row) => ({
      ...safeAccessLogRow(row as never),
      object: (row as never as { object: unknown }).object,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  });
}));

const maintenanceJobs = ["gc", "sweep", "scrub", "reconcile-locks", "rewrap", "av-scan"] as const;

router.post("/maintenance/:job", handler(async (request, response) => {
  requireAny(request, ["system:storage:admin"]);
  const { job } = parseOrThrow(z.object({ job: z.enum(maintenanceJobs) }).strict(), request.params);
  const sdk = getObjectStorageSdk();
  const workers = createObjectStorageWorkers({ sdk, prisma: sdk.prisma });
  const actor = actorOf(request);
  let result: unknown;
  switch (job) {
    case "gc":
      result = await sdk.workerClient.runGcBatch();
      break;
    case "sweep":
      result = await sdk.workerClient.runBlobSweep();
      break;
    case "scrub":
      result = await sdk.workerClient.runIntegrityScrubBatch(100);
      break;
    case "reconcile-locks":
      result = await sdk.workerClient.runLockReconcile();
      break;
    case "rewrap":
      result = await sdk.workerClient.runRewrapBatch(500);
      break;
    case "av-scan":
      result = await workers.runAvScanBatch(100);
      break;
  }
  await writeAudit(sdk.prisma, {
    data: {
      actorId: actor.userId,
      role: actor.role,
      action: "STORAGE_MAINTENANCE_RUN",
      entityType: "STORAGE_ENGINE",
      entityId: job,
      beforeJson: {},
      afterJson: { job, result: JSON.parse(JSON.stringify(result ?? null)) },
    },
  });
  response.json({ job, result });
}));

export const objectStorageAdminRouter = router;
