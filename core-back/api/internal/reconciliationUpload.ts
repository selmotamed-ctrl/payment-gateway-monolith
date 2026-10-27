import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { ApiError } from "../../lib/error";
import type { PrismaLike, Repositories, Tx } from "../../engine/db/ports";

/**
 * The upload of a statement file.
 *
 * The reconciliation of a statement with thousands of rows is a background
 * job: the request stores the uploaded file in the run record, queues the
 * job and answers `202 Accepted`. It never parses or matches the file.
 */
export interface ReconciliationUploadDeps {
  db: PrismaLike;
  repositories: Repositories;
  clock?: () => Date;
}

export interface ReconciliationUploadResult {
  runId: string;
  jobId: string;
  fileHash: string;
  state: "QUEUED";
  idempotent: boolean;
}

const readMetadata = (request: Request): Record<string, unknown> => {
  const header = request.headers["x-upload-metadata"];
  if (typeof header !== "string" || header.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const readWindow = (
  metadata: Record<string, unknown>,
  now: Date,
): { windowStart: Date; windowEnd: Date } => {
  const windowStart = typeof metadata.periodStart === "string" ? new Date(metadata.periodStart) : undefined;
  const windowEnd = typeof metadata.periodEnd === "string" ? new Date(metadata.periodEnd) : undefined;
  return {
    windowStart: windowStart && !Number.isNaN(windowStart.getTime())
      ? windowStart
      : new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
    windowEnd: windowEnd && !Number.isNaN(windowEnd.getTime()) ? windowEnd : now,
  };
};

/**
 * Builds the handler of the statement upload.
 *
 * The handler is a factory so that the route can be exercised against an
 * in-memory database.
 */
export const createReconciliationUploadHandler = (
  deps: ReconciliationUploadDeps,
) => async (request: Request, response: Response): Promise<void> => {
  const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  if (raw.byteLength === 0) {
    throw new ApiError(400, "STATEMENT_FILE_REQUIRED", "A statement file payload is required");
  }
  const sourceId = String(request.headers["x-statement-source-id"] ?? "");
  if (!sourceId) {
    throw new ApiError(400, "STATEMENT_SOURCE_REQUIRED", "The statement source identifier header is required");
  }
  const now = deps.clock?.() ?? new Date();
  const metadata = readMetadata(request);
  const { windowStart, windowEnd } = readWindow(metadata, now);
  const fileName = typeof request.headers["x-upload-filename"] === "string"
    ? decodeURIComponent(String(request.headers["x-upload-filename"]))
    : null;
  const fileHash = createHash("sha256").update(raw).digest("hex");

  const result = await deps.db.$transaction(async (tx: Tx) => {
    const source = await deps.repositories.reconciliation.findStatementSourceById(tx, sourceId);
    if (!source) {
      throw new ApiError(404, "STATEMENT_SOURCE_NOT_FOUND", "Statement source not found");
    }
    // The file hash is unique: the same statement never produces two runs.
    const existingRun = await deps.repositories.reconciliation.findRunByFileHash(tx, fileHash);
    const run = existingRun ?? await deps.repositories.reconciliation.createRun(tx, {
      statementSourceId: sourceId,
      windowStart,
      windowEnd,
      fileHash,
      statsJson: {},
      fileName,
      fileContent: raw,
    });
    // A repeated upload never queues the same work twice.
    const liveJob = await deps.repositories.jobs.findLiveJobForReference(
      tx,
      "RECONCILIATION_RUN",
      "RECONCILIATION_RUN",
      String(run.id),
    );
    const job = liveJob ?? await deps.repositories.jobs.enqueueJob(tx, {
      jobType: "RECONCILIATION_RUN",
      referenceType: "RECONCILIATION_RUN",
      referenceId: String(run.id),
      payload: { runId: String(run.id), statementSourceId: sourceId },
      availableAt: now,
    });
    return {
      runId: String(run.id),
      jobId: String(job.id),
      fileHash,
      state: "QUEUED" as const,
      idempotent: Boolean(existingRun),
    };
  }) as Promise<ReconciliationUploadResult>;

  response.status(202).json(result);
};
