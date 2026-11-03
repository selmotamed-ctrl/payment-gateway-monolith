import type { BackupEngine, BackupExecutionResult, BackupKind, BackupSummary, BackupTarget, EngineHealth, RecoverRequest, RecoverResult } from "../src/backupEngine";
import type { CatalogFileSystem } from "../src/catalogStore";
import type { CommandResult, CommandRunner, RunOptions } from "../src/commandRunner";
import { loadBackupDaemonConfig, type BackupDaemonConfig } from "../src/config";
import type { DrillFileSystem, DrillReport } from "../src/restoreDrillRunner";

export const ENCRYPTION_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const PG_PASSWORD = "super-secret-password";
export const S3_ACCESS_KEY = "AKIA-TEST-ACCESS";
export const S3_SECRET_KEY = "s3-test-secret-value";

export const baseEnv: Record<string, string> = {
  BACKUP_ENGINE_MODE: "wal-g",
  BACKUP_ENCRYPTION_KEY_HEX: ENCRYPTION_KEY_HEX,
  BACKUP_PRIMARY_S3_ENDPOINT: "https://s3.eu-central-1.amazonaws.com",
  BACKUP_PRIMARY_S3_BUCKET: "s3://libya-pg-backups-primary/prod",
  BACKUP_PRIMARY_S3_ACCESS_KEY: S3_ACCESS_KEY,
  BACKUP_PRIMARY_S3_SECRET_KEY: S3_SECRET_KEY,
  PG_PRIMARY_PASSWORD: PG_PASSWORD,
};

export const makeConfig = (overrides: Record<string, string> = {}): BackupDaemonConfig =>
  loadBackupDaemonConfig({ ...baseEnv, ...overrides });

export class RecordingRunner implements CommandRunner {
  public readonly calls: Array<{ command: string; args: string[]; options?: RunOptions }> = [];

  constructor(
    private readonly responder: (
      command: string,
      args: string[],
      options?: RunOptions,
    ) => CommandResult | Promise<CommandResult> = () => ({ code: 0, stdout: "", stderr: "" }),
  ) {}

  public async run(command: string, args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, args: [...args], options });
    return this.responder(command, args, options);
  }
}

export class FakeEngine implements BackupEngine {
  public readonly recovered: RecoverRequest[] = [];
  public health: EngineHealth = {
    healthy: true,
    wal: {
      archiveLagSeconds: 2,
      currentLsn: "0/16B6C50",
      lastArchivedLsn: "0/16B6C00",
      lagBytes: 80,
    },
    targets: [
      { id: "primary-s3", name: "Primary S3 Bucket", kind: "s3", healthy: true, detail: "reachable" },
      { id: "postgres-primary", name: "PostgreSQL Primary", kind: "database", healthy: true, detail: "reachable" },
    ],
  };

  public triggerCalls: Array<{ target: BackupTarget; kind: BackupKind }> = [];

  constructor(
    private readonly triggerImpl: (
      target: BackupTarget,
      kind: BackupKind,
    ) => Promise<BackupExecutionResult> = async () => ({ storageTargets: ["primary-s3"] }),
    private readonly recoverImpl: (request: RecoverRequest) => Promise<RecoverResult> = async () => ({
      replayedLsn: "0/16B6C50",
    }),
  ) {}

  public async overviewHealth(): Promise<EngineHealth> {
    return this.health;
  }

  public async triggerBackup(target: BackupTarget, kind: BackupKind): Promise<BackupExecutionResult> {
    this.triggerCalls.push({ target, kind });
    return this.triggerImpl(target, kind);
  }

  public async listBackups(_limit: number): Promise<BackupSummary[]> {
    return [];
  }

  public async recover(request: RecoverRequest): Promise<RecoverResult> {
    this.recovered.push(request);
    return this.recoverImpl(request);
  }
}

export class MemoryDrillFileSystem implements DrillFileSystem {
  public readonly removed: string[] = [];
  public readonly written = new Map<string, string>();
  public readonly writeHistory: Array<{ path: string; data: string }> = [];
  public readonly existing = new Set<string>();

  public constructor(initialFiles: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.existing.add(path);
      this.written.set(path, content);
    }
  }

  public async rm(path: string): Promise<void> {
    this.removed.push(path);
    for (const candidate of [...this.existing]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.existing.delete(candidate);
    }
    for (const candidate of [...this.written.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.written.delete(candidate);
    }
  }

  public async mkdir(path: string): Promise<void> {
    this.existing.add(path);
  }

  public async writeFile(path: string, data: string): Promise<void> {
    this.existing.add(path);
    this.written.set(path, data);
    this.writeHistory.push({ path, data });
  }

  public async readFile(path: string): Promise<string> {
    const value = this.written.get(path);
    if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return value;
  }

  public async exists(path: string): Promise<boolean> {
    return this.existing.has(path);
  }
}

export class MemoryCatalogFileSystem implements CatalogFileSystem {
  public readonly files = new Map<string, string>();

  public async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return value;
  }

  public async writeFile(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    const value = this.files.get(oldPath);
    if (value === undefined) throw new Error(`missing temporary file ${oldPath}`);
    this.files.delete(oldPath);
    this.files.set(newPath, value);
  }

  public async mkdir(): Promise<void> {}

  public async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
}

export class FailingCatalogFileSystem implements CatalogFileSystem {
  public async readFile(path: string): Promise<string> {
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  }

  public async writeFile(): Promise<void> {
    throw Object.assign(new Error("EACCES: catalog is read-only"), { code: "EACCES" });
  }

  public async rename(): Promise<void> {
    throw Object.assign(new Error("EACCES: catalog is read-only"), { code: "EACCES" });
  }

  public async mkdir(): Promise<void> {}

  public async unlink(): Promise<void> {}
}

export const makeDrillReport = (id: string, overrides: Partial<DrillReport> = {}): DrillReport => ({
  id,
  status: "PASSED",
  startedAt: "2026-11-03T10:00:00.000Z",
  completedAt: "2026-11-03T10:01:00.000Z",
  durationMs: 60_000,
  targetTime: "2026-11-03T09:55:00.000Z",
  replayedLsn: "0/16B6C50",
  doubleEntryDrift: "0.0000",
  balanceMismatches: 0,
  auditBrokenLinks: 0,
  journalLineCount: 42,
  checks: {
    doubleEntry: { ok: true, detail: "drift zero" },
    balanceParity: { ok: true, detail: "0 mismatches" },
    auditChain: { ok: true, detail: "verified" },
  },
  ...overrides,
});
