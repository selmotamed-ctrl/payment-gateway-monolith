import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { env } from "../env";

export const BACKUP_TARGETS = ["all", "postgres_core", "audit_db", "redis"] as const;
export const BACKUP_KINDS = ["full", "delta"] as const;

export type BackupTarget = (typeof BACKUP_TARGETS)[number];
export type BackupKind = (typeof BACKUP_KINDS)[number];

export interface BackupPolicy {
  fullCron: string;
  deltaCron: string;
  drillCron: string;
  fullRetentionDays: number;
  walRetentionDays: number;
  alertLagSeconds: number;
  updatedAt?: string;
  updatedBy?: string;
}

export interface BackupRun {
  id: string;
  target: BackupTarget;
  kind: BackupKind;
  engine: string;
  status: "QUEUED" | "RUNNING" | "PASSED" | "FAILED";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  sizeBytes?: number;
  startLsn?: string;
  endLsn?: string;
  storageTargets?: string[];
  errorMessage?: string;
}

export interface DrillCheck {
  ok: boolean;
  detail: string;
}

export interface DrillReport {
  id: string;
  status: "PASSED" | "FAILED";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  targetTime: string;
  replayedLsn: string;
  doubleEntryDrift: string;
  balanceMismatches: number;
  auditBrokenLinks: number;
  journalLineCount: number;
  checks: {
    doubleEntry: DrillCheck;
    balanceParity: DrillCheck;
    auditChain: DrillCheck;
  };
  errorMessage?: string;
  reportSignature?: string;
}

export interface BackupOverview {
  generatedAt: string;
  engineMode: string;
  healthy: boolean;
  wal: {
    archiveLagSeconds: number;
    currentLsn: string;
    lastArchivedLsn: string;
    lagBytes: number;
  };
  targets: Array<{
    id: string;
    name: string;
    kind: "s3" | "ssh" | "redis" | "database";
    healthy: boolean;
    detail?: string;
  }>;
  schedule: Omit<BackupPolicy, "updatedAt" | "updatedBy">;
  policy: BackupPolicy;
  backups: BackupRun[];
  latestDrill: DrillReport | null;
  drills: DrillReport[];
}

export class BackupDaemonError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 502,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "BackupDaemonError";
  }
}

export class BackupDaemonNotConfiguredError extends BackupDaemonError {
  constructor() {
    super(
      "BACKUP_DAEMON_URL is not configured",
      "BACKUP_DAEMON_NOT_CONFIGURED",
      503,
    );
    this.name = "BackupDaemonNotConfiguredError";
  }
}

const readFileIfPresent = (filePath: string | undefined): Buffer | undefined => {
  if (!filePath) {
    return undefined;
  }
  try {
    return fs.readFileSync(filePath);
  } catch {
    return undefined;
  }
};

const buildAgent = (baseUrl: string): http.Agent => {
  const isHttps = baseUrl.startsWith("https:");
  if (!isHttps) {
    return new http.Agent({ keepAlive: true, maxSockets: 8 });
  }
  return new https.Agent({
    keepAlive: true,
    maxSockets: 8,
    minVersion: "TLSv1.2",
    ca: readFileIfPresent(env.BACKUP_DAEMON_CA_CERT_PATH),
    cert: readFileIfPresent(env.BACKUP_DAEMON_CLIENT_CERT_PATH),
    key: readFileIfPresent(env.BACKUP_DAEMON_CLIENT_KEY_PATH),
    rejectUnauthorized: true,
  });
};

export interface BackupControlClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  request?: typeof http.request;
}

export class BackupControlClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly agent: http.Agent | undefined;
  private readonly requestImpl: typeof http.request;

  constructor(options: BackupControlClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? env.BACKUP_DAEMON_URL ?? "").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? env.BACKUP_DAEMON_TIMEOUT_MS;
    this.agent = this.baseUrl ? buildAgent(this.baseUrl) : undefined;
    this.requestImpl = options.request ?? (this.baseUrl.startsWith("https:") ? https.request : http.request);
  }

  public isConfigured(): boolean {
    return this.baseUrl.length > 0;
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new BackupDaemonNotConfiguredError();
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const url = new URL(`${this.baseUrl}${path}`);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const request = this.requestImpl(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method,
          agent: this.agent,
          headers: {
            accept: "application/json",
            ...(payload
              ? {
                  "content-type": "application/json",
                  "content-length": String(payload.length),
                }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown;
            try {
              parsed = text.length > 0 ? JSON.parse(text) : {};
            } catch {
              parsed = { raw: text };
            }
            const status = response.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve(parsed as T);
              return;
            }
            const envelope = parsed as {
              error?: { code?: string; message?: string; details?: unknown };
            };
            reject(
              new BackupDaemonError(
                envelope.error?.message ?? `Backup daemon returned HTTP ${status}`,
                envelope.error?.code ?? "BACKUP_DAEMON_ERROR",
                status,
                envelope.error?.details,
              ),
            );
          });
        },
      );
      request.setTimeout(timeoutMs, () => {
        request.destroy(
          new BackupDaemonError(
            `Backup daemon request timed out after ${timeoutMs}ms`,
            "BACKUP_DAEMON_TIMEOUT",
            504,
          ),
        );
      });
      request.on("error", (error) => {
        if (error instanceof BackupDaemonError) {
          reject(error);
          return;
        }
        reject(
          new BackupDaemonError(
            `Backup daemon unreachable: ${error.message}`,
            "BACKUP_DAEMON_UNREACHABLE",
            502,
            { cause: error.message },
          ),
        );
      });
      if (payload) {
        request.write(payload);
      }
      request.end();
    });
  }

  public overview(): Promise<BackupOverview> {
    return this.call<BackupOverview>("GET", "/v1/overview");
  }

  public health(): Promise<{ status: string; engineMode: string; version: string }> {
    return this.call("GET", "/health", undefined, { timeoutMs: 3_000 });
  }

  public triggerBackup(
    target: BackupTarget,
    kind: BackupKind,
    requestedBy?: string,
  ): Promise<{ backupJobId: string; acceptedAt: string }> {
    return this.call("POST", "/v1/backups/trigger", {
      target,
      kind,
      ...(requestedBy ? { requestedBy } : {}),
    });
  }

  public runDrill(
    requestedBy?: string,
  ): Promise<{ drillId: string; acceptedAt: string }> {
    return this.call("POST", "/v1/drills/run", {
      ...(requestedBy ? { requestedBy } : {}),
    });
  }

  public updatePolicy(policy: BackupPolicy): Promise<{ policy: BackupPolicy }> {
    return this.call("PUT", "/v1/policy", policy);
  }

  public listRuns(limit = 30): Promise<{ runs: BackupRun[] }> {
    return this.call("GET", `/v1/runs?limit=${Math.max(1, Math.min(limit, 500))}`);
  }

  public listDrills(limit = 30): Promise<{ drills: DrillReport[] }> {
    return this.call("GET", `/v1/drills?limit=${Math.max(1, Math.min(limit, 500))}`);
  }
}

let singleton: BackupControlClient | undefined;

export const getBackupControlClient = (): BackupControlClient => {
  if (!singleton) {
    singleton = new BackupControlClient();
  }
  return singleton;
};

export const resetBackupControlClient = (): void => {
  singleton = undefined;
};

export const isBackupDaemonConfigured = (): boolean => Boolean(env.BACKUP_DAEMON_URL);
