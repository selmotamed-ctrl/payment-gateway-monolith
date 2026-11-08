import express, { type Request, type Response } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { client } from "../../prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { requireAuthorities } from "../middleware/authDoubleCheck";
import {
  actorFromRequest,
  assertCheckerAuthority,
  assertCheckerIsNotMaker,
  type ApprovalActor,
} from "../middleware/makerCheckerGuard";
import { approvalIsExpired, normalizeApprovalSubjectType } from "../../lib/approvalQueue";
import {
  BACKUP_KINDS,
  BACKUP_TARGETS,
  BackupDaemonNotConfiguredError,
  type BackupOverview,
  type BackupPolicy,
  type BackupRun,
  type DrillReport,
  getBackupControlClient,
  isBackupDaemonConfigured,
} from "../../lib/storageEngine/backupControlClient";
import { stableJson } from "../../lib/storageEngine/auditAndLogAdapters";
import { writeAudit } from "../../lib/audit/writeAudit";

const router = express.Router();

const cronField = z
  .string()
  .trim()
  .refine(
    (value) => value.split(/\s+/).length === 5,
    "must be a five-field cron expression",
  );

export const backupPolicySchema = z
  .object({
    fullCron: cronField,
    deltaCron: cronField,
    drillCron: cronField,
    fullRetentionDays: z.coerce.number().int().min(1).max(3_650),
    walRetentionDays: z.coerce.number().int().min(1).max(3_650),
    alertLagSeconds: z.coerce.number().int().min(1).max(86_400),
    approvalRequestId: z.string().min(1).max(64).optional(),
  })
  .strict();

export const backupTriggerSchema = z
  .object({
    target: z.enum(BACKUP_TARGETS).default("all"),
    kind: z.enum(BACKUP_KINDS).default("full"),
  })
  .strict();

const defaultPolicy: BackupPolicy = {
  fullCron: "0 2 * * 0",
  deltaCron: "0 2 * * 1-6",
  drillCron: "0 4 * * 0",
  fullRetentionDays: 56,
  walRetentionDays: 14,
  alertLagSeconds: 60,
};

const emptyWal = {
  archiveLagSeconds: 0,
  currentLsn: "",
  lastArchivedLsn: "",
  lagBytes: 0,
};

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const localRuns = async (): Promise<BackupRun[]> => {
  const rows = await client.backupCatalogRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 30,
  });
  return rows.map((row) => ({
    id: row.id,
    target: row.target as BackupRun["target"],
    kind: row.kind as BackupRun["kind"],
    engine: row.engine,
    status: row.status as BackupRun["status"],
    startedAt: toIso(row.startedAt),
    ...(row.completedAt ? { completedAt: toIso(row.completedAt) } : {}),
    ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
    ...(row.sizeBytes !== null ? { sizeBytes: Number(row.sizeBytes) } : {}),
    ...(row.startLsn ? { startLsn: row.startLsn } : {}),
    ...(row.endLsn ? { endLsn: row.endLsn } : {}),
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
  }));
};

const localDrills = async (): Promise<DrillReport[]> => {
  const rows = await client.backupRestoreDrill.findMany({
    orderBy: { startedAt: "desc" },
    take: 10,
  });
  return rows.map((row) => {
    const checkpoints = (row.checkpointsJson ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      status: row.status as DrillReport["status"],
      startedAt: toIso(row.startedAt),
      completedAt: row.completedAt ? toIso(row.completedAt) : toIso(row.startedAt),
      durationMs: row.durationMs ?? 0,
      targetTime: row.targetTime ? toIso(row.targetTime) : toIso(row.startedAt),
      replayedLsn: row.replayedLsn ?? "",
      doubleEntryDrift: row.doubleEntryDrift.toString(),
      balanceMismatches: row.balanceMismatches,
      auditBrokenLinks: row.auditBrokenLinks,
      journalLineCount: Number(row.journalLineCount),
      checks: (checkpoints.checks as DrillReport["checks"]) ?? {
        doubleEntry: { ok: row.status === "PASSED", detail: "" },
        balanceParity: { ok: row.status === "PASSED", detail: "" },
        auditChain: { ok: row.status === "PASSED", detail: "" },
      },
      ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
      ...(row.reportSignature ? { reportSignature: row.reportSignature } : {}),
    };
  });
};

const syncDaemonCatalog = async (overview: BackupOverview): Promise<void> => {
  const runWrites = overview.backups.map((run) => {
    const startedAt = new Date(run.startedAt);
    const completedAt = run.completedAt ? new Date(run.completedAt) : null;
    return client.backupCatalogRun.upsert({
      where: { id: run.id },
      update: {
        target: run.target,
        kind: run.kind,
        engine: run.engine,
        status: run.status,
        startedAt,
        completedAt,
        durationMs: run.durationMs ?? null,
        sizeBytes: run.sizeBytes === undefined ? null : BigInt(Math.max(0, Math.trunc(run.sizeBytes))),
        startLsn: run.startLsn ?? null,
        endLsn: run.endLsn ?? null,
        storageTargets: (run.storageTargets ?? []) as Prisma.InputJsonValue,
        errorMessage: run.errorMessage ?? null,
      },
      create: {
        id: run.id,
        target: run.target,
        kind: run.kind,
        engine: run.engine,
        status: run.status,
        startedAt,
        completedAt,
        durationMs: run.durationMs ?? null,
        sizeBytes: run.sizeBytes === undefined ? null : BigInt(Math.max(0, Math.trunc(run.sizeBytes))),
        startLsn: run.startLsn ?? null,
        endLsn: run.endLsn ?? null,
        storageTargets: (run.storageTargets ?? []) as Prisma.InputJsonValue,
        errorMessage: run.errorMessage ?? null,
      },
    });
  });

  const drillWrites = overview.drills.map((drill) => {
    const startedAt = new Date(drill.startedAt);
    const completedAt = new Date(drill.completedAt);
    const targetTime = new Date(drill.targetTime);
    return client.backupRestoreDrill.upsert({
      where: { id: drill.id },
      update: {
        status: drill.status,
        startedAt,
        completedAt,
        durationMs: drill.durationMs,
        targetTime,
        replayedLsn: drill.replayedLsn || null,
        doubleEntryDrift: new Prisma.Decimal(drill.doubleEntryDrift || "0"),
        balanceMismatches: drill.balanceMismatches,
        auditBrokenLinks: drill.auditBrokenLinks,
        journalLineCount: BigInt(Math.max(0, Math.trunc(drill.journalLineCount))),
        checkpointsJson: { checks: drill.checks } as unknown as Prisma.InputJsonValue,
        errorMessage: drill.errorMessage ?? null,
        reportSignature: drill.reportSignature ?? null,
      },
      create: {
        id: drill.id,
        status: drill.status,
        startedAt,
        completedAt,
        durationMs: drill.durationMs,
        targetTime,
        replayedLsn: drill.replayedLsn || null,
        doubleEntryDrift: new Prisma.Decimal(drill.doubleEntryDrift || "0"),
        balanceMismatches: drill.balanceMismatches,
        auditBrokenLinks: drill.auditBrokenLinks,
        journalLineCount: BigInt(Math.max(0, Math.trunc(drill.journalLineCount))),
        checkpointsJson: { checks: drill.checks } as unknown as Prisma.InputJsonValue,
        errorMessage: drill.errorMessage ?? null,
        reportSignature: drill.reportSignature ?? null,
      },
    });
  });

  await Promise.allSettled([...runWrites, ...drillWrites]);
};

const daemonOverview = async (): Promise<{
  overview: BackupOverview | null;
  reachable: boolean;
  error?: string;
}> => {
  if (!isBackupDaemonConfigured()) {
    return { overview: null, reachable: false, error: "BACKUP_DAEMON_NOT_CONFIGURED" };
  }
  try {
    return { overview: await getBackupControlClient().overview(), reachable: true };
  } catch (error) {
    return {
      overview: null,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/** Only well-formed keys are forwarded; the daemon rejects anything else with 400. */
const idempotencyKeyOf = (request: Request): string | undefined => {
  const raw = request.header("idempotency-key")?.trim();
  return raw && /^[A-Za-z0-9._:-]{1,128}$/.test(raw) ? raw : undefined;
};

router.get("/overview", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read", "gateway:read"]);
  const [daemon, runs, drills] = await Promise.all([
    daemonOverview(),
    localRuns(),
    localDrills(),
  ]);
  const overview = daemon.overview;
  if (overview) {
    await syncDaemonCatalog(overview);
  }
  response.setHeader("Cache-Control", "no-store");
  response.json({
    configured: isBackupDaemonConfigured(),
    daemonReachable: daemon.reachable,
    ...(daemon.error ? { daemonError: daemon.error } : {}),
    generatedAt: overview?.generatedAt ?? new Date().toISOString(),
    engineMode: overview?.engineMode ?? "none",
    healthy: overview?.healthy ?? false,
    wal: overview?.wal ?? emptyWal,
    // One boolean for "is WAL reaching the archive in time": the daemon is healthy AND the archive lag is
    // within the alert threshold. Certification gate 10 and dashboards read this instead of re-deriving it.
    walArchiveHealthy: Boolean(
      overview?.healthy &&
        (overview?.wal?.archiveLagSeconds ?? 0) <= (overview?.policy?.alertLagSeconds ?? defaultPolicy.alertLagSeconds),
    ),
    targets: overview?.targets ?? [],
    schedule: overview?.schedule ?? defaultPolicy,
    policy: overview?.policy ?? defaultPolicy,
    backups: overview?.backups ?? runs,
    latestDrill: overview?.latestDrill ?? drills[0] ?? null,
    drills: overview?.drills ?? drills,
    localCatalog: { backups: runs, drills },
  });
});

router.post("/trigger", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:write"]);
  const body = parseOrThrow(backupTriggerSchema, request.body ?? {});
  if (!isBackupDaemonConfigured()) {
    throw new ApiError(
      503,
      "BACKUP_DAEMON_NOT_CONFIGURED",
      "The backup daemon is not configured for this deployment",
    );
  }
  const actor = actorFromRequest(request);
  const accepted = await getBackupControlClient().triggerBackup(
    body.target,
    body.kind,
    actor.userId ?? undefined,
    idempotencyKeyOf(request),
  );
  if (accepted.deduplicated) {
    // A retry of an already accepted request: the daemon returned the original job, nothing new was queued.
    response.status(202).json({
      backupJobId: accepted.backupJobId,
      acceptedAt: accepted.acceptedAt,
      target: body.target,
      kind: body.kind,
      deduplicated: true,
    });
    return;
  }

  const engineMode = (await daemonOverview()).overview?.engineMode ?? "unknown";
  await client.backupCatalogRun
    .create({
      data: {
        id: accepted.backupJobId,
        target: body.target,
        kind: body.kind,
        engine: engineMode,
        status: "QUEUED",
        startedAt: new Date(accepted.acceptedAt),
        storageTargets: { requestedBy: actor.userId ?? null },
      },
    })
    .catch(() => undefined);

  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "BACKUP_TRIGGERED",
      entityType: "BACKUP_JOB",
      entityId: accepted.backupJobId,
      beforeJson: {},
      afterJson: { target: body.target, kind: body.kind },
    },
  }).catch(() => undefined);
  response.status(202).json({
    backupJobId: accepted.backupJobId,
    acceptedAt: accepted.acceptedAt,
    target: body.target,
    kind: body.kind,
  });
});

router.post("/drill", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:write"]);
  if (!isBackupDaemonConfigured()) {
    throw new ApiError(
      503,
      "BACKUP_DAEMON_NOT_CONFIGURED",
      "The backup daemon is not configured for this deployment",
    );
  }
  const actor = actorFromRequest(request);
  const accepted = await getBackupControlClient().runDrill(actor.userId ?? undefined, idempotencyKeyOf(request));
  if (accepted.deduplicated) {
    response.status(202).json({ drillId: accepted.drillId, acceptedAt: accepted.acceptedAt, deduplicated: true });
    return;
  }
  const startedAt = new Date(accepted.acceptedAt);
  await client.backupRestoreDrill
    .create({
      data: {
        id: accepted.drillId,
        status: "QUEUED",
        startedAt,
        targetTime: new Date(startedAt.getTime() - 5 * 60 * 1000),
        checkpointsJson: { requestedBy: actor.userId ?? null },
      },
    })
    .catch(() => undefined);

  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "BACKUP_DRILL_TRIGGERED",
      entityType: "BACKUP_DRILL",
      entityId: accepted.drillId,
      beforeJson: {},
      afterJson: {},
    },
  }).catch(() => undefined);
  response.status(202).json({
    drillId: accepted.drillId,
    acceptedAt: accepted.acceptedAt,
  });
});

export interface BackupPolicyApprovalExecution {
  approvalId: string;
  state: string;
  checkerUserId: string;
  policy: BackupPolicy;
}

/**
 * Executes an approved `BACKUP_POLICY` request. It is the single implementation behind both
 * `POST /approvals/:id/approve` and `PUT /system/backups/policy` (with an `approvalRequestId`), so
 * the two entry points can never differ in what they enforce:
 *
 * - the caller must hold checker authority (`approval:check`), not merely `security:write`;
 * - the request must be pending, unexpired, and checked by someone other than its maker;
 * - the request is claimed with a conditional update BEFORE the daemon is called, so two
 *   concurrent checkers cannot both apply it; a failed daemon call releases the claim;
 * - only then is the policy sent to the daemon, and the approval is marked `EXECUTED` together
 *   with its audit row.
 */
export const executeBackupPolicyApproval = async (input: {
  approvalId: string;
  actor: ApprovalActor;
  riskAcceptanceNote?: string;
}): Promise<BackupPolicyApprovalExecution> => {
  const { actor } = input;
  assertCheckerAuthority(actor);
  const approval = await client.approvalRequest.findUnique({ where: { id: input.approvalId } });
  if (!approval || normalizeApprovalSubjectType(approval.subjectType) !== "BACKUP_POLICY") {
    throw new ApiError(404, "APPROVAL_NOT_FOUND", "The backup policy approval does not exist");
  }
  assertCheckerIsNotMaker(approval.makerUserId, actor.userId);
  if (approval.state !== "PENDING_REVIEW" && approval.state !== "DRAFT") {
    throw new ApiError(409, "APPROVAL_NOT_PENDING", "The approval request is not pending review");
  }
  if (approvalIsExpired(approval.expiresAt)) {
    throw new ApiError(409, "APPROVAL_EXPIRED", "The approval request has expired");
  }
  if (!isBackupDaemonConfigured()) {
    throw new ApiError(
      503,
      "BACKUP_DAEMON_NOT_CONFIGURED",
      "The backup daemon is not configured for this deployment",
    );
  }
  const payload = backupPolicySchema.omit({ approvalRequestId: true }).parse(approval.payloadDiffJson ?? {});
  const policy: BackupPolicy = {
    fullCron: payload.fullCron,
    deltaCron: payload.deltaCron,
    drillCron: payload.drillCron,
    fullRetentionDays: payload.fullRetentionDays,
    walRetentionDays: payload.walRetentionDays,
    alertLagSeconds: payload.alertLagSeconds,
  };

  // Claim first: only one caller can move the request out of its pending state.
  const claimed = await client.approvalRequest.updateMany({
    where: { id: approval.id, state: { in: ["PENDING_REVIEW", "DRAFT"] } },
    data: { state: "APPROVED", checkerUserId: actor.userId },
  });
  if (claimed.count !== 1) {
    throw new ApiError(409, "APPROVAL_NOT_PENDING", "The approval request is not pending review");
  }

  let updated: { policy: BackupPolicy };
  try {
    updated = await getBackupControlClient().updatePolicy({ ...policy, updatedBy: actor.userId });
  } catch (error) {
    // The daemon did not take the policy: give the request back so it can be retried.
    await client.approvalRequest
      .updateMany({
        where: { id: approval.id, state: "APPROVED", checkerUserId: actor.userId },
        data: { state: "PENDING_REVIEW", checkerUserId: null },
      })
      .catch(() => undefined);
    throw error;
  }

  const executed = await client.$transaction(async (tx) => {
    const row = await tx.approvalRequest.update({
      where: { id: approval.id },
      data: {
        state: "EXECUTED",
        checkerUserId: actor.userId,
        riskAcceptanceNote: input.riskAcceptanceNote,
        baseVersion: (approval.baseVersion ?? 0) + 1,
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "UNKNOWN",
        action: "BACKUP_POLICY_UPDATED",
        entityType: "BACKUP_POLICY",
        entityId: approval.id,
        approvalRequestId: approval.id,
        beforeJson: (approval.payloadDiffJson ?? {}) as Record<string, unknown>,
        afterJson: {
          policy: updated.policy,
          approvalRequestId: approval.id,
          checksum: stableJson(updated.policy).slice(0, 64),
        },
      },
    });
    return row;
  });
  return {
    approvalId: executed.id,
    state: executed.state,
    checkerUserId: actor.userId,
    policy: updated.policy,
  };
};

router.put("/policy", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:write"]);
  const body = parseOrThrow(backupPolicySchema, request.body ?? {});
  const actor = actorFromRequest(request);
  const policy: BackupPolicy = {
    fullCron: body.fullCron,
    deltaCron: body.deltaCron,
    drillCron: body.drillCron,
    fullRetentionDays: body.fullRetentionDays,
    walRetentionDays: body.walRetentionDays,
    alertLagSeconds: body.alertLagSeconds,
  };

  if (!body.approvalRequestId) {
    const approval = await client.approvalRequest.create({
      data: {
        subjectType: "BACKUP_POLICY",
        subjectId: "backup-policy",
        payloadDiffJson: policy as unknown as Prisma.InputJsonValue,
        mode: "STANDARD",
        makerUserId: actor.userId,
        state: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    response.status(202).json({
      status: "PENDING_REVIEW",
      approvalRequestId: approval.id,
      policy,
      checkerRequired: true,
    });
    return;
  }

  const executed = await executeBackupPolicyApproval({
    approvalId: body.approvalRequestId,
    actor,
  });
  response.json({
    executed: true,
    approvalRequestId: executed.approvalId,
    policy: executed.policy,
  });
});

router.get("/catalog", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read", "gateway:read"]);
  const [runs, drills] = await Promise.all([localRuns(), localDrills()]);
  response.json({ runs, drills });
});

export const backupInternalRouter = router;

export const _internal = { BackupDaemonNotConfiguredError };
