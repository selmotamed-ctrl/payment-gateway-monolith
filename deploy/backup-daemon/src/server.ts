import { randomUUID } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { z } from "zod";
import type { BackupEngine, BackupStorageTarget, WalHealth } from "./backupEngine";
import { BACKUP_KINDS, BACKUP_TARGETS } from "./backupEngine";
import type { CatalogStore } from "./catalogStore";
import {
  collectSecretValues,
  isValidCron,
  redactSensitiveData,
  redactText,
  type BackupDaemonConfig,
} from "./config";
import { signDrillReport, type DrillReport, type DrillRunOptions } from "./restoreDrillRunner";
import type { SchedulerState } from "./scheduler";

export interface DrillRunnerLike {
  run(options?: DrillRunOptions): Promise<DrillReport>;
}

export interface SchedulerStateProvider {
  getState?: () => SchedulerState;
  state?: SchedulerState;
}

export interface BackupDaemonServerOptions {
  config: BackupDaemonConfig;
  engine: BackupEngine;
  drillRunner: DrillRunnerLike;
  catalog: CatalogStore;
  scheduler?: SchedulerStateProvider;
  version?: string;
  clock?: () => Date;
  idFactory?: () => string;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface HandlerBundle {
  handler: (request: Request) => Promise<Response>;
  whenIdle: () => Promise<void>;
  pendingCount: () => number;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const cronSchema = z.string().trim().refine(isValidCron, "must be a five-field cron expression");

export const policyUpdateSchema = z.object({
  fullCron: cronSchema,
  deltaCron: cronSchema,
  drillCron: cronSchema,
  fullRetentionDays: z.coerce.number().int().min(1).max(3650),
  walRetentionDays: z.coerce.number().int().min(1).max(3650),
  alertLagSeconds: z.coerce.number().int().min(1).max(86_400),
  updatedBy: z.string().trim().min(1).max(200).optional(),
});

export const triggerBackupSchema = z.object({
  target: z.enum(BACKUP_TARGETS),
  kind: z.enum(BACKUP_KINDS),
  requestedBy: z.string().trim().min(1).max(200).optional(),
});

export const drillRunSchema = z.object({
  requestedBy: z.string().trim().min(1).max(200).optional(),
});

const emptyWal = (): WalHealth => ({
  archiveLagSeconds: 0,
  currentLsn: "",
  lastArchivedLsn: "",
  lagBytes: 0,
});

const issueMessage = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "body"}: ${issue.message}`)
    .join("; ");

const MAX_BODY_BYTES = 256 * 1024;

const readJsonBody = async (request: Request): Promise<unknown> => {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", "request body exceeds the maximum size");
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new HttpError(400, "invalid_body", "request body could not be read");
  }
  if (text.length > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", "request body exceeds the maximum size");
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "request body must be valid JSON");
  }
};

const parseLimit = (url: URL, fallback = 30): number => {
  const raw = url.searchParams.get("limit");
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new HttpError(400, "invalid_limit", "limit must be an integer between 1 and 500");
  }
  return parsed;
};

export const createBackupDaemonHandler = (options: BackupDaemonServerOptions): HandlerBundle => {
  const { config, engine, drillRunner, catalog } = options;
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => randomUUID());
  const version = options.version ?? "1.0.0";
  const secretValues = collectSecretValues(config);
  const pending = new Set<Promise<void>>();
  const issuedIds = new Set<string>();
  const existing = catalog.snapshot();
  for (const run of existing.runs) issuedIds.add(run.id);
  for (const drill of existing.drills) issuedIds.add(drill.id);

  const reserveId = (): string => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = idFactory();
      if (id && !issuedIds.has(id)) {
        issuedIds.add(id);
        return id;
      }
    }
    throw new HttpError(500, "id_generation_failed", "unable to allocate a unique identifier");
  };

  const track = (task: Promise<void>): void => {
    let wrapped: Promise<void>;
    wrapped = task
      .catch((error) => {
        options.logger?.error("background task failed", error);
      })
      .finally(() => {
        pending.delete(wrapped);
      });
    pending.add(wrapped);
  };

  const whenIdle = async (): Promise<void> => {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  };

  const safeMessage = (error: unknown): string =>
    redactText(error instanceof Error ? error.message : String(error), secretValues).slice(0, 2000);

  return {
    whenIdle,
    pendingCount: () => pending.size,
    handler: async (request: Request): Promise<Response> => {
      const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
      const respond = (data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response =>
        new Response(JSON.stringify(redactSensitiveData(data, secretValues)), {
          status,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": requestId,
            "cache-control": "no-store",
            ...extraHeaders,
          },
        });

      try {
        const url = new URL(request.url);
        const method = request.method.toUpperCase();
        const path = url.pathname.replace(/\/+$/, "") || "/";

        const requireMethod = (allowed: string): void => {
          if (method !== allowed) {
            throw new HttpError(405, "method_not_allowed", `${method} is not allowed for ${path}`);
          }
        };

        if (path === "/health") {
          requireMethod("GET");
          return respond({ status: "ok", engineMode: config.BACKUP_ENGINE_MODE, version });
        }

        if (path === "/v1/overview") {
          requireMethod("GET");
          let health: { healthy: boolean; wal: WalHealth; targets: BackupStorageTarget[] };
          try {
            health = await engine.overviewHealth();
          } catch (error) {
            health = {
              healthy: false,
              wal: emptyWal(),
              targets: [
                {
                  id: "engine",
                  name: "Backup Engine",
                  kind: "database",
                  healthy: false,
                  detail: safeMessage(error),
                },
              ],
            };
          }
          const policy = catalog.getPolicy();
          const backups = catalog.listRuns(30);
          const drills = catalog.listDrills(10);
          return respond({
            generatedAt: clock().toISOString(),
            engineMode: config.BACKUP_ENGINE_MODE,
            healthy: health.healthy,
            wal: health.wal ?? emptyWal(),
            targets: Array.isArray(health.targets) ? health.targets : [],
            schedule: {
              fullCron: policy.fullCron,
              deltaCron: policy.deltaCron,
              drillCron: policy.drillCron,
              fullRetentionDays: policy.fullRetentionDays,
              walRetentionDays: policy.walRetentionDays,
              alertLagSeconds: policy.alertLagSeconds,
            },
            policy,
            scheduler:
              options.scheduler?.getState?.() ??
              options.scheduler?.state ?? {
                enabled: false,
                nextFullAt: null,
                nextDeltaAt: null,
                nextDrillAt: null,
              },
            backups,
            latestDrill: catalog.latestDrill(),
            drills,
          });
        }

        if (path === "/v1/backups/trigger") {
          requireMethod("POST");
          const parsed = triggerBackupSchema.safeParse(await readJsonBody(request));
          if (!parsed.success) {
            throw new HttpError(400, "validation_error", issueMessage(parsed.error));
          }
          const acceptedAt = clock().toISOString();
          const id = reserveId();
          const run = {
            id,
            target: parsed.data.target,
            kind: parsed.data.kind,
            engine: config.BACKUP_ENGINE_MODE,
            status: "QUEUED" as const,
            startedAt: acceptedAt,
            storageTargets: [],
          };
          await catalog.addRun(run);

          const job = (async (): Promise<void> => {
            await catalog.updateRun(id, { status: "RUNNING" });
            try {
              const result = await engine.triggerBackup(parsed.data.target, parsed.data.kind);
              const completed = clock();
              await catalog.updateRun(id, {
                status: "PASSED",
                completedAt: completed.toISOString(),
                durationMs: Math.max(0, completed.getTime() - Date.parse(acceptedAt)),
                sizeBytes: result.sizeBytes,
                startLsn: result.startLsn,
                endLsn: result.endLsn,
                storageTargets: result.storageTargets ?? [],
              });
            } catch (error) {
              const completed = clock();
              await catalog.updateRun(id, {
                status: "FAILED",
                completedAt: completed.toISOString(),
                durationMs: Math.max(0, completed.getTime() - Date.parse(acceptedAt)),
                storageTargets: [],
                errorMessage: safeMessage(error),
              });
            }
          })();
          track(job);
          return respond({ backupJobId: id, acceptedAt }, 202);
        }

        if (path === "/v1/drills/run") {
          requireMethod("POST");
          const parsed = drillRunSchema.safeParse(await readJsonBody(request));
          if (!parsed.success) {
            throw new HttpError(400, "validation_error", issueMessage(parsed.error));
          }
          const acceptedAt = clock().toISOString();
          const id = reserveId();
          const startedMs = Date.parse(acceptedAt);

          const job = (async (): Promise<void> => {
            try {
              const report = await drillRunner.run({ id, requestedBy: parsed.data.requestedBy });
              await catalog.addDrill(report);
            } catch (error) {
              const completed = clock();
              const failed: DrillReport = {
                id,
                status: "FAILED",
                startedAt: acceptedAt,
                completedAt: completed.toISOString(),
                durationMs: Math.max(0, completed.getTime() - startedMs),
                targetTime: new Date(startedMs - 5 * 60 * 1000).toISOString(),
                replayedLsn: "",
                doubleEntryDrift: "",
                balanceMismatches: 0,
                auditBrokenLinks: 0,
                journalLineCount: 0,
                checks: {
                  doubleEntry: { ok: false, detail: "not executed" },
                  balanceParity: { ok: false, detail: "not executed" },
                  auditChain: { ok: false, detail: "not executed" },
                },
                errorMessage: safeMessage(error),
              };
              await catalog.addDrill({
                ...failed,
                reportSignature: signDrillReport(failed, config.BACKUP_ENCRYPTION_KEY_HEX),
              });
            }
          })();
          track(job);
          return respond({ drillId: id, acceptedAt }, 202);
        }

        if (path === "/v1/policy") {
          requireMethod("PUT");
          const parsed = policyUpdateSchema.safeParse(await readJsonBody(request));
          if (!parsed.success) {
            throw new HttpError(400, "validation_error", issueMessage(parsed.error));
          }
          const policy = await catalog.updatePolicy({
            ...parsed.data,
            updatedAt: clock().toISOString(),
          });
          return respond({ policy });
        }

        if (path === "/v1/runs") {
          requireMethod("GET");
          return respond({ runs: catalog.listRuns(parseLimit(url)) });
        }

        if (path === "/v1/drills") {
          requireMethod("GET");
          return respond({ drills: catalog.listDrills(parseLimit(url)) });
        }

        throw new HttpError(404, "not_found", `no route for ${method} ${path}`);
      } catch (error) {
        if (error instanceof HttpError) {
          return respond(
            { error: { code: error.code, message: error.message, requestId } },
            error.status,
          );
        }
        options.logger?.error("unhandled request failure", error);
        return respond(
          { error: { code: "internal_error", message: "internal server error", requestId } },
          500,
        );
      }
    },
  };
};

export type TlsReadFile = (path: string) => Promise<string>;

export const loadTlsOptions = async (
  config: BackupDaemonConfig,
  readFile: TlsReadFile = (path) => nodeFs.readFile(path, "utf8"),
): Promise<Bun.TLSOptions | undefined> => {
  if (config.BACKUP_ALLOW_INSECURE_HTTP) return undefined;
  if (!config.BACKUP_DAEMON_CERT_PATH || !config.BACKUP_DAEMON_KEY_PATH) {
    throw new Error(
      "TLS requires BACKUP_DAEMON_CERT_PATH and BACKUP_DAEMON_KEY_PATH; " +
        "set BACKUP_ALLOW_INSECURE_HTTP=true only for local tests/development",
    );
  }
  if (!config.BACKUP_DAEMON_CA_CERT_PATH) {
    throw new Error(
      "mTLS requires BACKUP_DAEMON_CA_CERT_PATH; " +
        "set BACKUP_ALLOW_INSECURE_HTTP=true only for local tests/development",
    );
  }
  const tls: Bun.TLSOptions = {
    cert: await readFile(config.BACKUP_DAEMON_CERT_PATH),
    key: await readFile(config.BACKUP_DAEMON_KEY_PATH),
    ca: await readFile(config.BACKUP_DAEMON_CA_CERT_PATH),
    requestCert: true,
    rejectUnauthorized: true,
  };
  return tls;
};

export interface RunningBackupDaemonServer extends HandlerBundle {
  server: ReturnType<typeof Bun.serve>;
  stop: (closeActiveConnections?: boolean) => void;
}

export const startBackupDaemonServer = async (
  options: BackupDaemonServerOptions,
): Promise<RunningBackupDaemonServer> => {
  const tls = await loadTlsOptions(options.config);
  const bundle = createBackupDaemonHandler(options);
  const server = Bun.serve({
    hostname: options.config.BACKUP_DAEMON_BIND_HOST,
    port: options.config.BACKUP_DAEMON_PORT,
    ...(tls ? { tls } : {}),
    fetch: bundle.handler,
    error: (error) => {
      options.logger?.error("server error", error);
      return new Response(
        JSON.stringify({ error: { code: "internal_error", message: "internal server error" } }),
        { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    },
  });
  return {
    ...bundle,
    server,
    stop: (closeActiveConnections = true) => server.stop(closeActiveConnections),
  };
};
