import { afterAll, describe, expect, test } from "bun:test";
import express, { type NextFunction, type Request, type Response } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  backupPolicySchema,
  backupTriggerSchema,
  backupInternalRouter,
} from "../../api/internal/backups";
import { isApiError, toErrorEnvelope } from "../../lib/error";
import type { Principal } from "../../api/middleware/authDoubleCheck";
import {
  resetBackupControlClient,
} from "../../lib/storageEngine/backupControlClient";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  createPrisma,
  describeDatabase,
  uniqueId,
  uniqueUuid,
} from "../storage-engine/helpers/db";

const client: PrismaClient = createPrisma({ max: 5 });
const createdRuns: string[] = [];
const createdDrills: string[] = [];

const originalUrl = process.env.BACKUP_DAEMON_URL;

afterAll(async () => {
  if (createdRuns.length > 0) {
    await client.backupCatalogRun.deleteMany({ where: { id: { in: createdRuns } } }).catch(() => undefined);
  }
  if (createdDrills.length > 0) {
    await client.backupRestoreDrill.deleteMany({ where: { id: { in: createdDrills } } }).catch(() => undefined);
  }
  await client.$disconnect().catch(() => undefined);
  if (originalUrl === undefined) {
    delete process.env.BACKUP_DAEMON_URL;
  } else {
    process.env.BACKUP_DAEMON_URL = originalUrl;
  }
  resetBackupControlClient();
});

const principal: Principal = {
  kind: "session",
  userId: uniqueUuid(),
  role: "SECURITY_ADMIN",
  merchantId: null,
  applicationId: null,
  authorities: ["security:read", "security:write", "gateway:read", "approval:check"],
  scopes: [],
  tokenId: null,
  sessionId: null,
};

/** When set, a request may pick its principal's user id with `x-test-user` (for race tests). */
let principalByHeader = false;

interface RunningApp {
  url: string;
  close: () => Promise<void>;
}

const startApp = async (): Promise<RunningApp> => {
  const app = express();
  app.use(express.json());
  app.use((request: Request, _response: Response, next: NextFunction) => {
    const asUser = principalByHeader ? request.header("x-test-user") : undefined;
    request.principal = asUser ? { ...principal, userId: asUser } : principal;
    next();
  });
  app.use("/system/backups", backupInternalRouter);
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (isApiError(error)) {
        response.status(error.statusCode).json(toErrorEnvelope(error));
        return;
      }
      response.status(500).json({
        code: "SERVER_ERROR",
        message: error instanceof Error ? error.message : "unknown error",
      });
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }
          resolve();
        }),
      );
    },
  };
};

interface RunningDaemon {
  url: string;
  requests: Array<{ method: string; url: string; body: string; headers: http.IncomingHttpHeaders }>;
  close: () => Promise<void>;
}

interface DaemonOptions {
  walLagSeconds?: number;
  healthy?: boolean;
  /** Answer trigger/drill as an Idempotency-Key retry of this already accepted job. */
  deduplicatedJobId?: string;
  /** Answer `PUT /v1/policy` with a 500 while this returns true (it is read on every call). */
  failPolicy?: () => boolean;
  /** Delay `PUT /v1/policy`, so concurrent callers overlap inside the daemon call. */
  policyDelayMs?: number;
}

const startDaemon = async (options: DaemonOptions = {}): Promise<RunningDaemon> => {
  const requests: RunningDaemon["requests"] = [];
  const overview = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    engineMode: "postgres",
    healthy: options.healthy ?? true,
    wal: { archiveLagSeconds: options.walLagSeconds ?? 1, currentLsn: "0/10", lastArchivedLsn: "0/9", lagBytes: 8 },
    targets: [{ id: "s3", name: "offsite", kind: "s3", healthy: true }],
    schedule: {
      fullCron: "0 2 * * 0",
      deltaCron: "0 2 * * 1-6",
      drillCron: "0 4 * * 0",
      fullRetentionDays: 56,
      walRetentionDays: 14,
      alertLagSeconds: 60,
    },
    policy: {
      fullCron: "0 2 * * 0",
      deltaCron: "0 2 * * 1-6",
      drillCron: "0 4 * * 0",
      fullRetentionDays: 56,
      walRetentionDays: 14,
      alertLagSeconds: 60,
    },
    backups: [],
    latestDrill: null,
    drills: [],
  };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method ?? "", url: request.url ?? "", body, headers: request.headers });
      const send = (status: number, payload: unknown): void => {
        const text = JSON.stringify(payload);
        response.writeHead(status, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(text),
        });
        response.end(text);
      };
      if (request.method === "GET" && request.url === "/v1/overview") {
        send(200, overview);
        return;
      }
      if (request.method === "POST" && request.url === "/v1/backups/trigger") {
        send(202, {
          backupJobId: options.deduplicatedJobId ?? uniqueUuid(),
          acceptedAt: new Date().toISOString(),
          ...(options.deduplicatedJobId ? { deduplicated: true } : {}),
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/drills/run") {
        send(202, {
          drillId: options.deduplicatedJobId ?? uniqueUuid(),
          acceptedAt: new Date().toISOString(),
          ...(options.deduplicatedJobId ? { deduplicated: true } : {}),
        });
        return;
      }
      if (request.method === "PUT" && request.url === "/v1/policy") {
        const respond = (): void => {
          if (options.failPolicy?.()) {
            send(500, { error: { code: "POLICY_REJECTED", message: "daemon failure" } });
            return;
          }
          send(200, { policy: JSON.parse(body) });
        };
        if (options.policyDelayMs) setTimeout(respond, options.policyDelayMs);
        else respond();
        return;
      }
      send(404, { error: { code: "NOT_FOUND", message: "not found" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }
          resolve();
        }),
      );
    },
  };
};

const configureDaemon = (url: string | undefined): void => {
  if (url === undefined) {
    delete process.env.BACKUP_DAEMON_URL;
  } else {
    process.env.BACKUP_DAEMON_URL = url;
  }
  resetBackupControlClient();
};

const postJson = async (
  app: RunningApp,
  path: string,
  body: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> => {
  const response = await fetch(`${app.url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json, headers: response.headers };
};

describe("backup control-plane zod schemas", () => {
  test("trigger schema defaults target/kind and is strict", () => {
    expect(backupTriggerSchema.parse({})).toEqual({ target: "all", kind: "full" });
    expect(backupTriggerSchema.parse({ target: "redis", kind: "delta" })).toEqual({
      target: "redis",
      kind: "delta",
    });
    expect(backupTriggerSchema.safeParse({ target: "unknown" }).success).toBe(false);
    expect(backupTriggerSchema.safeParse({ kind: "incremental" }).success).toBe(false);
    expect(backupTriggerSchema.safeParse({ target: "all", extra: true }).success).toBe(false);
    expect(backupTriggerSchema.safeParse({ target: null }).success).toBe(false);
  });

  test("policy schema enforces five-field cron, retention bounds and strictness", () => {
    const valid = {
      fullCron: "0 2 * * 0",
      deltaCron: "0 2 * * 1-6",
      drillCron: "0 4 * * 0",
      fullRetentionDays: 56,
      walRetentionDays: 14,
      alertLagSeconds: 60,
    };
    expect(backupPolicySchema.parse(valid)).toEqual(valid);
    expect(
      backupPolicySchema.parse({
        ...valid,
        fullRetentionDays: "1",
        walRetentionDays: "3650",
        alertLagSeconds: "86400",
      }),
    ).toEqual({
      ...valid,
      fullRetentionDays: 1,
      walRetentionDays: 3650,
      alertLagSeconds: 86400,
    });
    expect(backupPolicySchema.safeParse({ ...valid, fullCron: "0 2 * *" }).success).toBe(false);
    expect(
      backupPolicySchema.safeParse({ ...valid, fullCron: "0 2 * * 0 1" }).success,
    ).toBe(false);
    expect(
      backupPolicySchema.safeParse({ ...valid, deltaCron: "not even close" }).success,
    ).toBe(false);
    expect(
      backupPolicySchema.safeParse({ ...valid, fullRetentionDays: 0 }).success,
    ).toBe(false);
    expect(
      backupPolicySchema.safeParse({ ...valid, fullRetentionDays: 3_651 }).success,
    ).toBe(false);
    expect(backupPolicySchema.safeParse({ ...valid, walRetentionDays: 0 }).success).toBe(false);
    expect(
      backupPolicySchema.safeParse({ ...valid, alertLagSeconds: 86_401 }).success,
    ).toBe(false);
    expect(backupPolicySchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(
      backupPolicySchema.parse({ ...valid, approvalRequestId: "approval-1" }),
    ).toMatchObject({ approvalRequestId: "approval-1" });
  });
});

describeDatabase("backup internal routes against a fake daemon (live PostgreSQL)", () => {
  test("overview combines the daemon payload with the local catalog", async () => {
    const daemon = await startDaemon();
    configureDaemon(daemon.url);
    const app = await startApp();
    try {
      const response = await fetch(`${app.url}/system/backups/overview`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.configured).toBe(true);
      expect(body.daemonReachable).toBe(true);
      expect(body.engineMode).toBe("postgres");
      expect(body.healthy).toBe(true);
      expect(body.policy).toMatchObject({ fullRetentionDays: 56 });
      expect(Array.isArray(body.localCatalog)).toBe(false);
      expect(body.localCatalog).toMatchObject({ backups: expect.any(Array), drills: expect.any(Array) });
      expect(daemon.requests.some((request) => request.url === "/v1/overview")).toBe(true);
    } finally {
      await app.close();
      await daemon.close();
      configureDaemon(undefined);
    }
  });

  test("walArchiveHealthy is true only when the daemon is healthy AND archive lag is within the alert threshold", async () => {
    const check = async (options: DaemonOptions): Promise<unknown> => {
      const daemon = await startDaemon(options);
      configureDaemon(daemon.url);
      const app = await startApp();
      try {
        const response = await fetch(`${app.url}/system/backups/overview`);
        return ((await response.json()) as Record<string, unknown>).walArchiveHealthy;
      } finally {
        await app.close();
        await daemon.close();
        configureDaemon(undefined);
      }
    };
    expect(await check({ walLagSeconds: 1 })).toBe(true); // alertLagSeconds is 60
    expect(await check({ walLagSeconds: 60 })).toBe(true); // at the threshold
    expect(await check({ walLagSeconds: 61 })).toBe(false); // beyond it
    expect(await check({ walLagSeconds: 1, healthy: false })).toBe(false); // unhealthy storage target
  });

  test("walArchiveHealthy is false when the daemon is not configured", async () => {
    configureDaemon(undefined);
    const app = await startApp();
    try {
      const body = (await (await fetch(`${app.url}/system/backups/overview`)).json()) as Record<string, unknown>;
      expect(body.walArchiveHealthy).toBe(false);
    } finally {
      await app.close();
    }
  });

  test("an Idempotency-Key is forwarded to the daemon; a deduplicated answer queues nothing new locally", async () => {
    const original = uniqueUuid();
    const daemon = await startDaemon({ deduplicatedJobId: original });
    configureDaemon(daemon.url);
    const app = await startApp();
    try {
      const response = await fetch(`${app.url}/system/backups/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "click-12345678" },
        body: JSON.stringify({ target: "all", kind: "full" }),
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ backupJobId: original, deduplicated: true });
      const forwarded = daemon.requests.find((request) => request.url === "/v1/backups/trigger");
      expect(forwarded?.headers["idempotency-key"]).toBe("click-12345678");
      expect(await client.backupCatalogRun.findUnique({ where: { id: original } })).toBeNull();

      const drill = await fetch(`${app.url}/system/backups/drill`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "drill-12345678" },
        body: "{}",
      });
      expect(await drill.json()).toMatchObject({ drillId: original, deduplicated: true });
      expect(daemon.requests.find((request) => request.url === "/v1/drills/run")?.headers["idempotency-key"]).toBe("drill-12345678");
      expect(await client.backupRestoreDrill.findUnique({ where: { id: original } })).toBeNull();

      // a malformed key is not forwarded (the daemon would answer 400)
      await fetch(`${app.url}/system/backups/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "bad key!" },
        body: JSON.stringify({ target: "all", kind: "full" }),
      });
      const last = daemon.requests.filter((request) => request.url === "/v1/backups/trigger").at(-1);
      expect(last?.headers["idempotency-key"]).toBeUndefined();
    } finally {
      await app.close();
      await daemon.close();
      configureDaemon(undefined);
    }
  });

  test("overview degrades cleanly when the daemon is not configured", async () => {
    configureDaemon(undefined);
    const app = await startApp();
    try {
      const response = await fetch(`${app.url}/system/backups/overview`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        configured: false,
        daemonReachable: false,
        daemonError: "BACKUP_DAEMON_NOT_CONFIGURED",
        engineMode: "none",
        healthy: false,
      });
      expect(body.schedule).toMatchObject({ fullRetentionDays: 56 });
    } finally {
      await app.close();
    }
  });

  test("trigger defaults to all/full, persists a QUEUED catalog run and returns 202", async () => {
    const daemon = await startDaemon();
    configureDaemon(daemon.url);
    const app = await startApp();
    try {
      const response = await postJson(app, "/system/backups/trigger", {});
      expect(response.status).toBe(202);
      expect(response.json).toMatchObject({ target: "all", kind: "full" });
      const id = response.json.backupJobId as string;
      createdRuns.push(id);
      const row = await client.backupCatalogRun.findUnique({ where: { id } });
      expect(row).toMatchObject({
        target: "all",
        kind: "full",
        status: "QUEUED",
        engine: "postgres",
      });
      const trigger = daemon.requests.find(
        (request) => request.url === "/v1/backups/trigger",
      );
      expect(JSON.parse(trigger?.body ?? "{}")).toMatchObject({
        target: "all",
        kind: "full",
        requestedBy: principal.userId,
      });
    } finally {
      await app.close();
      await daemon.close();
      configureDaemon(undefined);
    }
  });

  test("trigger rejects strictness violations and the unconfigured daemon", async () => {
    configureDaemon(undefined);
    const app = await startApp();
    try {
      const invalid = await postJson(app, "/system/backups/trigger", { target: "nope" });
      expect(invalid.status).toBe(400);
      expect(invalid.json.code).toBe("INVALID_BODY");
      const unconfigured = await postJson(app, "/system/backups/trigger", {
        target: "redis",
        kind: "delta",
        extra: true,
      });
      expect(unconfigured.status).toBe(400);

      const notConfigured = await postJson(app, "/system/backups/trigger", {
        target: "redis",
        kind: "delta",
      });
      expect(notConfigured.status).toBe(503);
      expect(notConfigured.json.code).toBe("BACKUP_DAEMON_NOT_CONFIGURED");
    } finally {
      await app.close();
    }
  });

  test("drill accepts a run and persists a QUEUED local drill", async () => {
    const daemon = await startDaemon();
    configureDaemon(daemon.url);
    const app = await startApp();
    try {
      const response = await postJson(app, "/system/backups/drill", {});
      expect(response.status).toBe(202);
      const id = response.json.drillId as string;
      createdDrills.push(id);
      const row = await client.backupRestoreDrill.findUnique({ where: { id } });
      expect(row?.status).toBe("QUEUED");
      expect(row?.targetTime).not.toBeNull();
      const drill = daemon.requests.find((request) => request.url === "/v1/drills/run");
      expect(JSON.parse(drill?.body ?? "{}")).toMatchObject({
        requestedBy: principal.userId,
      });
    } finally {
      await app.close();
      await daemon.close();
      configureDaemon(undefined);
    }
  });

  test("policy updates without an approval open a maker-checker request", async () => {
    const userId = uniqueUuid();
    const email = `${uniqueId("backup-policy")}@example.test`;
    await client.user.create({
      data: {
        id: userId,
        email,
        role: "SECURITY_ADMIN",
        authoritiesMap: { "security:write": true },
        status: "ACTIVE",
        mfaRequired: false,
      },
    });
    const app = await startApp();
    // The route reads the actor from the injected principal.
    principal.userId = userId;
    try {
      const policy = {
        fullCron: "0 3 * * 0",
        deltaCron: "0 3 * * 1-6",
        drillCron: "0 5 * * 0",
        fullRetentionDays: 30,
        walRetentionDays: 7,
        alertLagSeconds: 90,
      };
      const response = await postJson(app, "/system/backups/policy", policy, "PUT");
      expect(response.status).toBe(202);
      expect(response.json).toMatchObject({ status: "PENDING_REVIEW", checkerRequired: true });
      const approvalId = response.json.approvalRequestId as string;
      const approval = await client.approvalRequest.findUnique({ where: { id: approvalId } });
      expect(approval).toMatchObject({
        subjectType: "BACKUP_POLICY",
        subjectId: "backup-policy",
        state: "PENDING_REVIEW",
        makerUserId: userId,
        mode: "STANDARD",
      });
      expect(approval?.payloadDiffJson).toMatchObject(policy);

      const missing = await postJson(
        app,
        "/system/backups/policy",
        { ...policy, approvalRequestId: uniqueUuid() },
        "PUT",
      );
      expect(missing.status).toBe(404);
      expect(missing.json.code).toBe("APPROVAL_NOT_FOUND");

      await client.approvalRequest.delete({ where: { id: approvalId } });
    } finally {
      await app.close();
      await client.approvalRequest.deleteMany({ where: { makerUserId: userId } });
      await client.user.delete({ where: { id: userId } });
    }
  });

  test("a backup trigger and a drill leave audit rows naming the actor and the job", async () => {
    const actor = await client.user.create({
      data: {
        id: uniqueUuid(),
        email: `${uniqueId("bp-audit")}@example.test`,
        role: "SECURITY_ADMIN",
        authoritiesMap: { "security:write": true },
        status: "ACTIVE",
        mfaRequired: false,
      },
    });
    const daemon = await startDaemon();
    configureDaemon(daemon.url);
    const app = await startApp();
    const previous = principal.userId;
    principal.userId = actor.id;
    try {
      const trigger = await postJson(app, "/system/backups/trigger", { target: "redis", kind: "delta" });
      expect(trigger.status).toBe(202);
      createdRuns.push(trigger.json.backupJobId as string);
      const drill = await postJson(app, "/system/backups/drill", {});
      expect(drill.status).toBe(202);
      createdDrills.push(drill.json.drillId as string);

      const triggerAudit = await client.auditLog.findFirst({ where: { entityId: trigger.json.backupJobId as string } });
      expect(triggerAudit).toMatchObject({ action: "BACKUP_TRIGGERED", actorId: actor.id, entityType: "BACKUP_JOB" });
      expect(triggerAudit?.afterJson).toEqual({ target: "redis", kind: "delta" });
      const drillAudit = await client.auditLog.findFirst({ where: { entityId: drill.json.drillId as string } });
      expect(drillAudit).toMatchObject({ action: "BACKUP_DRILL_TRIGGERED", actorId: actor.id });
    } finally {
      principal.userId = previous;
      configureDaemon(undefined);
      await app.close();
      await daemon.close();
    }
  });

  describe("applying an approved policy (PUT /policy with approvalRequestId)", () => {
    const policy = {
      fullCron: "0 3 * * 0",
      deltaCron: "0 3 * * 1-6",
      drillCron: "0 5 * * 0",
      fullRetentionDays: 30,
      walRetentionDays: 7,
      alertLagSeconds: 90,
    };
    const originalAuthorities = [...principal.authorities];
    const originalUserId = principal.userId;

    const createUser = async (label: string): Promise<string> => {
      const id = uniqueUuid();
      await client.user.create({
        data: {
          id,
          email: `${uniqueId(label)}@example.test`,
          role: "SECURITY_ADMIN",
          authoritiesMap: { "security:write": true },
          status: "ACTIVE",
          mfaRequired: false,
        },
      });
      return id;
    };

    const createApproval = async (
      makerUserId: string,
      overrides: { state?: "PENDING_REVIEW" | "EXECUTED" | "APPROVED"; expiresAt?: Date } = {},
    ): Promise<string> => {
      const approval = await client.approvalRequest.create({
        data: {
          subjectType: "BACKUP_POLICY",
          subjectId: "backup-policy",
          payloadDiffJson: policy,
          mode: "STANDARD",
          makerUserId,
          state: overrides.state ?? "PENDING_REVIEW",
          expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      return approval.id;
    };

    const actAs = (userId: string, authorities: string[]): void => {
      principal.userId = userId;
      principal.authorities = authorities;
    };

    const stateOf = async (id: string) =>
      client.approvalRequest.findUnique({ where: { id }, select: { state: true, checkerUserId: true } });

    const policyPuts = (daemon: RunningDaemon) =>
      daemon.requests.filter((request) => request.method === "PUT" && request.url === "/v1/policy");

    const restore = (): void => {
      principal.userId = originalUserId;
      principal.authorities = [...originalAuthorities];
      configureDaemon(undefined);
    };

    test("a checker with approval:check applies it: claimed, sent to the daemon once, executed and audited", async () => {
      const [maker, checker] = [await createUser("bp-maker"), await createUser("bp-checker")];
      const approvalId = await createApproval(maker);
      const daemon = await startDaemon();
      configureDaemon(daemon.url);
      const app = await startApp();
      try {
        actAs(checker, ["security:write", "approval:check"]);
        const response = await postJson(app, "/system/backups/policy", { ...policy, approvalRequestId: approvalId }, "PUT");
        expect(response.status).toBe(200);
        expect(response.json).toMatchObject({ executed: true, approvalRequestId: approvalId });
        expect(policyPuts(daemon)).toHaveLength(1);
        expect(JSON.parse(policyPuts(daemon)[0]!.body)).toMatchObject({ ...policy, updatedBy: checker });
        expect(await stateOf(approvalId)).toEqual({ state: "EXECUTED", checkerUserId: checker });
        const audit = await client.auditLog.findMany({ where: { approvalRequestId: approvalId } });
        expect(audit.map((row) => row.action)).toEqual(["BACKUP_POLICY_UPDATED"]);

        // Executed requests can never be applied again.
        const again = await postJson(app, "/system/backups/policy", { ...policy, approvalRequestId: approvalId }, "PUT");
        expect(again.status).toBe(409);
        expect(again.json.code).toBe("APPROVAL_NOT_PENDING");
        expect(policyPuts(daemon)).toHaveLength(1);
      } finally {
        restore();
        await app.close();
        await daemon.close();
      }
    });

    test("security:write alone is not checker authority: the pending approval stays pending", async () => {
      const [maker, writer] = [await createUser("bp-maker"), await createUser("bp-writer")];
      const approvalId = await createApproval(maker);
      const daemon = await startDaemon();
      configureDaemon(daemon.url);
      const app = await startApp();
      try {
        actAs(writer, ["security:write"]);
        const response = await postJson(app, "/system/backups/policy", { ...policy, approvalRequestId: approvalId }, "PUT");
        expect(response.status).toBe(403);
        expect(response.json.code).toBe("APPROVAL_CHECKER_AUTHORITY_REQUIRED");
        expect(policyPuts(daemon)).toHaveLength(0);
        expect(await stateOf(approvalId)).toEqual({ state: "PENDING_REVIEW", checkerUserId: null });
      } finally {
        restore();
        await app.close();
        await daemon.close();
      }
    });

    test("the maker cannot check their own request", async () => {
      const maker = await createUser("bp-maker");
      const approvalId = await createApproval(maker);
      const daemon = await startDaemon();
      configureDaemon(daemon.url);
      const app = await startApp();
      try {
        actAs(maker, ["security:write", "approval:check"]);
        const response = await postJson(app, "/system/backups/policy", { ...policy, approvalRequestId: approvalId }, "PUT");
        expect(response.status).toBe(409);
        expect(response.json.code).toBe("APPROVAL_MAKER_EQUALS_CHECKER");
        expect(policyPuts(daemon)).toHaveLength(0);
        expect(await stateOf(approvalId)).toEqual({ state: "PENDING_REVIEW", checkerUserId: null });
      } finally {
        restore();
        await app.close();
        await daemon.close();
      }
    });

    test("an expired request, and one that is not pending, are refused before the daemon is called", async () => {
      const [maker, checker] = [await createUser("bp-maker"), await createUser("bp-checker")];
      const expired = await createApproval(maker, { expiresAt: new Date(Date.now() - 1000) });
      const approvedButUnexecuted = await createApproval(maker, { state: "APPROVED" });
      const daemon = await startDaemon();
      configureDaemon(daemon.url);
      const app = await startApp();
      try {
        actAs(checker, ["security:write", "approval:check"]);
        const late = await postJson(app, "/system/backups/policy", { ...policy, approvalRequestId: expired }, "PUT");
        expect(late.status).toBe(409);
        expect(late.json.code).toBe("APPROVAL_EXPIRED");
        const stale = await postJson(app, "/system/backups/policy", { ...policy, approvalRequestId: approvedButUnexecuted }, "PUT");
        expect(stale.status).toBe(409);
        expect(stale.json.code).toBe("APPROVAL_NOT_PENDING");
        expect(policyPuts(daemon)).toHaveLength(0);
        expect((await stateOf(expired))?.state).toBe("PENDING_REVIEW");
        expect((await stateOf(approvedButUnexecuted))?.state).toBe("APPROVED");
      } finally {
        restore();
        await app.close();
        await daemon.close();
      }
    });

    test("two checkers racing apply it exactly once", async () => {
      const [maker, checkerA, checkerB] = [
        await createUser("bp-maker"),
        await createUser("bp-checker-a"),
        await createUser("bp-checker-b"),
      ];
      const approvalId = await createApproval(maker);
      // The daemon call is slow, so both requests are inside it unless the claim comes first.
      const daemon = await startDaemon({ policyDelayMs: 150 });
      configureDaemon(daemon.url);
      const app = await startApp();
      try {
        const attempt = async (userId: string) => {
          // The route reads the principal per request, so give each racer its own app.
          const racer = await startApp();
          try {
            const response = await fetch(`${racer.url}/system/backups/policy`, {
              method: "PUT",
              headers: { "content-type": "application/json", "x-test-user": userId },
              body: JSON.stringify({ ...policy, approvalRequestId: approvalId }),
            });
            return { status: response.status, json: (await response.json()) as Record<string, unknown> };
          } finally {
            await racer.close();
          }
        };
        principalByHeader = true;
        const results = await Promise.all([attempt(checkerA), attempt(checkerB)]);
        const statuses = results.map((result) => result.status).sort();
        expect(statuses).toEqual([200, 409]);
        expect(results.find((result) => result.status === 409)?.json.code).toBe("APPROVAL_NOT_PENDING");
        expect(policyPuts(daemon)).toHaveLength(1);
        expect((await stateOf(approvalId))?.state).toBe("EXECUTED");
      } finally {
        principalByHeader = false;
        restore();
        await app.close();
        await daemon.close();
      }
    });

    test("a daemon failure releases the claim so the request can be retried and then succeeds", async () => {
      const [maker, checker] = [await createUser("bp-maker"), await createUser("bp-checker")];
      const approvalId = await createApproval(maker);
      let failing = true;
      const daemon = await startDaemon({ failPolicy: () => failing });
      configureDaemon(daemon.url);
      const app = await startApp();
      try {
        actAs(checker, ["security:write", "approval:check"]);
        const failed = await postJson(app, "/system/backups/policy", { ...policy, approvalRequestId: approvalId }, "PUT");
        expect(failed.status).toBeGreaterThanOrEqual(400);
        expect(await stateOf(approvalId)).toEqual({ state: "PENDING_REVIEW", checkerUserId: null });
        expect(await client.auditLog.count({ where: { approvalRequestId: approvalId } })).toBe(0);

        failing = false;
        const retried = await postJson(app, "/system/backups/policy", { ...policy, approvalRequestId: approvalId }, "PUT");
        expect(retried.status).toBe(200);
        expect(await stateOf(approvalId)).toEqual({ state: "EXECUTED", checkerUserId: checker });
        expect(policyPuts(daemon)).toHaveLength(2);
      } finally {
        restore();
        await app.close();
        await daemon.close();
      }
    });
  });

  test("the local catalog endpoint returns only local rows", async () => {
    configureDaemon(undefined);
    const app = await startApp();
    try {
      const response = await fetch(`${app.url}/system/backups/catalog`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { runs: unknown[]; drills: unknown[] };
      expect(Array.isArray(body.runs)).toBe(true);
      expect(Array.isArray(body.drills)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
