import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { promises as nodeFs, chmodSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { z } from "zod";
import type { BackupEngine, BackupStorageTarget, WalHealth } from "./backupEngine";
import { JobQueue, QueueFullError } from "./jobQueue";
import { WalIngestError } from "./walArchive";
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
  /** Shared with the scheduler so a manual trigger and a scheduled slot never overlap. */
  jobs?: JobQueue;
  /** Copies/verifies the shared object-storage vault after a successful backup. Returns extra storage target ids. */
  syncObjectStorage?: () => Promise<string[]>;
}

/**
 * Who is calling. `control` is the core-back `backup-client` certificate (every
 * route except WAL ingest); `wal` is the database host's `wal-archive-client`
 * certificate (ONLY `PUT /v1/wal/...`); `open` is plain-HTTP development mode
 * where no identity exists and every route is reachable.
 */
export type CallerRole = "control" | "wal" | "open";

export interface HandlerBundle {
  /** Handler for the `open` role (plain HTTP / tests). */
  handler: (request: Request) => Promise<Response>;
  handlerFor: (role: CallerRole) => (request: Request) => Promise<Response>;
  whenIdle: () => Promise<void>;
  pendingCount: () => number;
  jobs: JobQueue;
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
  /** Recover to this moment (ISO-8601, not in the future). Defaults to now - 5 minutes. */
  targetTime: z.string().trim().min(1).max(40).optional(),
  /** Replay ALL available WAL (disaster-recovery rehearsal). Mutually exclusive with `targetTime`. */
  latest: z.boolean().optional(),
});

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const WAL_ROUTE = /^\/v1\/wal\/([a-z_]+)\/([^/]+)$/;

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
  const jobs = options.jobs ?? new JobQueue({ clock, logger: options.logger });
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
    while (pending.size > 0 || jobs.isBusy()) {
      await Promise.allSettled([...pending]);
      await jobs.whenIdle();
    }
  };

  const idempotencyKeyOf = (request: Request): string | undefined => {
    const raw = request.headers.get("idempotency-key")?.trim();
    if (!raw) return undefined;
    if (!IDEMPOTENCY_KEY_PATTERN.test(raw)) {
      throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 1-128 characters of [A-Za-z0-9._:-]");
    }
    return raw;
  };

  const enqueue = (spec: Parameters<JobQueue["enqueue"]>[0]): ReturnType<JobQueue["enqueue"]> => {
    try {
      return jobs.enqueue(spec);
    } catch (error) {
      if (error instanceof QueueFullError) throw new HttpError(429, "queue_full", error.message);
      throw error;
    }
  };

  const safeMessage = (error: unknown): string =>
    redactText(error instanceof Error ? error.message : String(error), secretValues).slice(0, 2000);

  const handle = async (request: Request, role: CallerRole): Promise<Response> => {
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

        const walMatch = WAL_ROUTE.exec(path);
        if (role === "wal" && !walMatch) {
          throw new HttpError(403, "forbidden", "this client certificate may only upload WAL");
        }
        if (role === "control" && walMatch) {
          throw new HttpError(403, "forbidden", "WAL upload requires the WAL archive client certificate");
        }

        if (path === "/health") {
          requireMethod("GET");
          return respond({ status: "ok", engineMode: config.BACKUP_ENGINE_MODE, version });
        }

        if (walMatch) {
          requireMethod("PUT");
          if (!engine.ingestWal) {
            throw new HttpError(501, "wal_push_not_supported", `engine ${config.BACKUP_ENGINE_MODE} does not accept WAL uploads`);
          }
          if (!request.body) throw new HttpError(400, "empty_wal_file", "empty WAL upload");
          const lengthHeader = request.headers.get("content-length");
          const declared = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
          try {
            const outcome = await engine.ingestWal(walMatch[1]!, decodeURIComponent(walMatch[2]!), Readable.fromWeb(request.body as never), declared);
            return respond({ status: outcome.status, key: outcome.key, bytes: outcome.bytes });
          } catch (error) {
            if (error instanceof WalIngestError) throw new HttpError(error.status, error.code, error.message);
            throw error;
          }
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
            jobs: { active: jobs.activeJob(), queued: jobs.queuedCount() },
            ...(engine.walStatus ? { walArchive: engine.walStatus() } : {}),
          });
        }

        if (path === "/v1/backups/trigger") {
          requireMethod("POST");
          const parsed = triggerBackupSchema.safeParse(await readJsonBody(request));
          if (!parsed.success) {
            throw new HttpError(400, "validation_error", issueMessage(parsed.error));
          }
          const idempotencyKey = idempotencyKeyOf(request);
          const known = idempotencyKey ? jobs.lookupKey("backup", idempotencyKey) : undefined;
          if (known) {
            return respond({ backupJobId: known.id, acceptedAt: known.acceptedAt, deduplicated: true }, 202);
          }
          const acceptedAt = clock().toISOString();
          const id = reserveId();
          // addRun inserts the row synchronously, and nothing awaits between this lookup and enqueue(),
          // so two requests with the same key can never both get past the check above.
          const ready = catalog.addRun({
            id,
            target: parsed.data.target,
            kind: parsed.data.kind,
            engine: config.BACKUP_ENGINE_MODE,
            status: "QUEUED",
            startedAt: acceptedAt,
            storageTargets: [],
          });
          let ticket: ReturnType<JobQueue["enqueue"]>;
          try {
            ticket = enqueue({
              id,
              kind: "backup",
              scope: "backup",
              idempotencyKey,
              run: async () => {
                await ready;
                const startedMs = clock().getTime();
                await catalog.updateRun(id, { status: "RUNNING" });
                try {
                  const result = await engine.triggerBackup(parsed.data.target, parsed.data.kind);
                  const extraTargets = await options.syncObjectStorage?.();
                  if (extraTargets && extraTargets.length > 0) result.storageTargets.push(...extraTargets);
                  const completed = clock();
                  await catalog.updateRun(id, {
                    status: "PASSED",
                    completedAt: completed.toISOString(),
                    durationMs: Math.max(0, completed.getTime() - startedMs),
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
                    durationMs: Math.max(0, completed.getTime() - startedMs),
                    storageTargets: [],
                    errorMessage: safeMessage(error),
                  });
                }
              },
            });
          } catch (error) {
            await ready;
            await catalog.updateRun(id, {
              status: "FAILED",
              completedAt: clock().toISOString(),
              errorMessage: safeMessage(error),
            });
            throw error;
          }
          await ready;
          track(ticket.done);
          return respond({ backupJobId: id, acceptedAt, queuePosition: ticket.position }, 202);
        }

        if (path === "/v1/drills/run") {
          requireMethod("POST");
          const parsed = drillRunSchema.safeParse(await readJsonBody(request));
          if (!parsed.success) {
            throw new HttpError(400, "validation_error", issueMessage(parsed.error));
          }
          if (parsed.data.latest && parsed.data.targetTime !== undefined) {
            throw new HttpError(400, "validation_error", "latest and targetTime are mutually exclusive");
          }
          let targetTime: Date | undefined;
          if (parsed.data.targetTime !== undefined) {
            targetTime = new Date(parsed.data.targetTime);
            if (Number.isNaN(targetTime.getTime())) {
              throw new HttpError(400, "validation_error", "targetTime must be an ISO-8601 timestamp");
            }
            if (targetTime.getTime() > clock().getTime()) {
              throw new HttpError(400, "validation_error", "targetTime cannot be in the future");
            }
          }
          const idempotencyKey = idempotencyKeyOf(request);
          const acceptedAt = clock().toISOString();
          const id = idempotencyKey ? (jobs.lookupKey("drill", idempotencyKey)?.id ?? reserveId()) : reserveId();
          const ticket = enqueue({
            id,
            kind: "drill",
            scope: "drill",
            idempotencyKey,
            run: async () => {
              const startedMs = clock().getTime();
              try {
                const report = await drillRunner.run({ id, requestedBy: parsed.data.requestedBy, targetTime, ...(parsed.data.latest ? { latest: true } : {}) });
                await catalog.addDrill(report);
              } catch (error) {
                const completed = clock();
                const failed: DrillReport = {
                  id,
                  status: "FAILED",
                  startedAt: new Date(startedMs).toISOString(),
                  completedAt: completed.toISOString(),
                  durationMs: Math.max(0, completed.getTime() - startedMs),
                  targetTime: (targetTime ?? new Date(startedMs - 5 * 60 * 1000)).toISOString(),
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
            },
          });
          if (ticket.deduplicated) {
            return respond({ drillId: ticket.id, acceptedAt: ticket.acceptedAt, deduplicated: true }, 202);
          }
          track(ticket.done);
          return respond({ drillId: id, acceptedAt, queuePosition: ticket.position }, 202);
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
        // The client went away mid-request (timeout, reset, a client that closed a pooled socket): nobody is left to
        // answer and it is not a server fault. Logging it as an "unhandled request failure" only creates noise that
        // hides real problems.
        if ((error as { name?: string } | null)?.name === "AbortError") {
          return new Response(null, { status: 499 });
        }
        options.logger?.error("unhandled request failure", error);
        return respond(
          { error: { code: "internal_error", message: "internal server error", requestId } },
          500,
        );
      }
  };

  return {
    whenIdle,
    pendingCount: () => pending.size + (jobs.isBusy() ? 1 : 0),
    jobs,
    handler: (request: Request) => handle(request, "open"),
    handlerFor: (role: CallerRole) => (request: Request) => handle(request, role),
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

/** Identity of the TLS peer as exposed by `tls.TLSSocket#getPeerCertificate()`. */
export interface PeerCertificateLike {
  subject?: { CN?: string | string[] };
  subjectaltname?: string;
}

export const parseAllowedClientCns = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/**
 * mTLS authorization: a certificate signed by the internal CA is only
 * authenticated, not authorized. The peer's subject CN (or a DNS SAN) must be
 * in the allowlist (BACKUP_ALLOWED_CLIENT_CNS, default `backup-client`).
 */
export const isAllowedClientIdentity = (cert: PeerCertificateLike | undefined, allowed: string[]): boolean => {
  if (!cert || allowed.length === 0) return false;
  const cn = cert.subject?.CN;
  const cns = Array.isArray(cn) ? cn : cn ? [cn] : [];
  if (cns.some((value) => allowed.includes(value))) return true;
  const dnsNames = (cert.subjectaltname ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("DNS:"))
    .map((entry) => entry.slice(4));
  return dnsNames.some((value) => allowed.includes(value));
};

const FORBIDDEN_BODY = JSON.stringify({ error: { code: "forbidden", message: "client certificate is not authorized" } });
const FORBIDDEN_RESPONSE =
  "HTTP/1.1 403 Forbidden\r\ncontent-type: application/json; charset=utf-8\r\nconnection: close\r\n" +
  `content-length: ${Buffer.byteLength(FORBIDDEN_BODY)}\r\n\r\n${FORBIDDEN_BODY}`;

/**
 * Bun.serve cannot expose the peer certificate (and Bun's node:https server has no
 * `socket.getPeerCertificate()` either), so the public TLS listener is a node:tls
 * server that verifies the client certificate, classifies its identity and only then
 * bridges the decrypted stream to an inner Bun HTTP server on a private unix socket
 * (loopback port on Windows).
 *
 * Authorization is per ROLE, enforced by which inner server the connection is bridged
 * to: `backup-client` certificates reach the control-plane handler, `wal-archive-client`
 * certificates reach a handler that serves nothing but `PUT /v1/wal/...`. Anything else
 * gets 403. No HTTP parsing happens in the gateway, so there is nothing to desynchronize.
 */
const startMtlsGateway = async (
  options: BackupDaemonServerOptions,
  tlsOptions: Bun.TLSOptions,
  bundle: HandlerBundle,
): Promise<RunningBackupDaemonServer> => {
  const controlAllowed = parseAllowedClientCns(options.config.BACKUP_ALLOWED_CLIENT_CNS);
  const walAllowed = parseAllowedClientCns(options.config.BACKUP_WAL_CLIENT_CNS);
  const fail = (error: Error): Response => {
    options.logger?.error("server error", error);
    return new Response(
      JSON.stringify({ error: { code: "internal_error", message: "internal server error" } }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  };
  let socketDir: string | undefined;
  if (process.platform !== "win32") {
    socketDir = mkdtempSync(join(tmpdir(), "pg-backup-daemon-"));
    chmodSync(socketDir, 0o700);
  }
  const inners: Partial<Record<"control" | "wal", { server: ReturnType<typeof Bun.serve>; upstream: net.NetConnectOpts }>> = {};
  for (const role of ["control", "wal"] as const) {
    const fetchHandler = bundle.handlerFor(role);
    const maxRequestBodySize = options.config.BACKUP_WAL_PUSH_MAX_BYTES + 1024 * 1024;
    if (process.platform === "win32") {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fetchHandler, error: fail, maxRequestBodySize });
      inners[role] = { server, upstream: { host: "127.0.0.1", port: server.port ?? 0 } };
    } else {
      const socketPath = join(socketDir!, `${role}.sock`);
      inners[role] = {
        server: Bun.serve({ unix: socketPath, fetch: fetchHandler, error: fail, maxRequestBodySize }),
        upstream: { path: socketPath },
      };
    }
  }
  const front = tls.createServer(
    {
      cert: tlsOptions.cert as string,
      key: tlsOptions.key as string,
      ca: tlsOptions.ca as string,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (socket) => {
      const peer = socket.getPeerCertificate();
      const role: "control" | "wal" | null = !socket.authorized
        ? null
        : isAllowedClientIdentity(peer, controlAllowed)
          ? "control"
          : isAllowedClientIdentity(peer, walAllowed)
            ? "wal"
            : null;
      if (role === null) {
        options.logger?.warn("rejected mTLS client: certificate identity is not authorized for any role");
        socket.on("error", () => undefined);
        socket.end(FORBIDDEN_RESPONSE);
        return;
      }
      const backend = net.connect(inners[role]!.upstream);
      socket.on("error", () => backend.destroy());
      backend.on("error", () => socket.destroy());
      socket.pipe(backend);
      backend.pipe(socket);
    },
  );
  await new Promise<void>((resolveListen, rejectListen) => {
    front.once("error", rejectListen);
    front.listen(options.config.BACKUP_DAEMON_PORT, options.config.BACKUP_DAEMON_BIND_HOST, () => resolveListen());
  });
  return {
    ...bundle,
    server: inners.control!.server,
    stop: () => {
      front.close();
      inners.control!.server.stop(true);
      inners.wal!.server.stop(true);
      if (socketDir) rmSync(socketDir, { recursive: true, force: true });
    },
  };
};

export const startBackupDaemonServer = async (
  options: BackupDaemonServerOptions,
): Promise<RunningBackupDaemonServer> => {
  const tlsOptions = await loadTlsOptions(options.config);
  const bundle = createBackupDaemonHandler(options);
  if (tlsOptions) return startMtlsGateway(options, tlsOptions, bundle);
  const server = Bun.serve({
    hostname: options.config.BACKUP_DAEMON_BIND_HOST,
    port: options.config.BACKUP_DAEMON_PORT,
    fetch: bundle.handler,
    maxRequestBodySize: options.config.BACKUP_WAL_PUSH_MAX_BYTES + 1024 * 1024,
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
