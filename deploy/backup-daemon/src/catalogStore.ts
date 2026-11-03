import { promises as nodeFs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { BackupEngineMode } from "./config";
import type { BackupKind, BackupTarget } from "./backupEngine";
import type { DrillReport } from "./restoreDrillRunner";

export type BackupRunStatus = "QUEUED" | "RUNNING" | "PASSED" | "FAILED";

export interface BackupRun {
  id: string;
  target: BackupTarget;
  kind: BackupKind;
  engine: BackupEngineMode;
  status: BackupRunStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  sizeBytes?: number;
  startLsn?: string;
  endLsn?: string;
  storageTargets: string[];
  errorMessage?: string;
}

export interface BackupPolicy {
  fullCron: string;
  deltaCron: string;
  drillCron: string;
  fullRetentionDays: number;
  walRetentionDays: number;
  alertLagSeconds: number;
  updatedAt: string;
  updatedBy?: string;
}

export interface BackupCatalog {
  runs: BackupRun[];
  drills: DrillReport[];
  policy: BackupPolicy;
}

export interface CatalogFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface CatalogStoreOptions {
  path: string;
  defaultPolicy?: BackupPolicy;
  fileSystem?: CatalogFileSystem;
  clock?: () => Date;
  maxRuns?: number;
  maxDrills?: number;
  onWarning?: (message: string) => void;
}

export const defaultCatalogFileSystem: CatalogFileSystem = {
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  writeFile: (path, data, encoding) => nodeFs.writeFile(path, data, encoding),
  rename: (oldPath, newPath) => nodeFs.rename(oldPath, newPath),
  mkdir: async (path, options) => {
    await nodeFs.mkdir(path, options);
  },
  unlink: (path) => nodeFs.unlink(path),
};

export const createDefaultPolicy = (overrides: Partial<BackupPolicy> = {}): BackupPolicy => ({
  fullCron: "0 2 * * 0",
  deltaCron: "0 2 * * 1-6",
  drillCron: "0 4 * * 0",
  fullRetentionDays: 56,
  walRetentionDays: 14,
  alertLagSeconds: 300,
  updatedAt: new Date(0).toISOString(),
  ...overrides,
});

const backupRunSchema = z.object({
  id: z.string().min(1),
  target: z.enum(["all", "postgres_core", "audit_db", "redis"]),
  kind: z.enum(["full", "delta"]),
  engine: z.enum(["wal-g", "barman"]),
  status: z.enum(["QUEUED", "RUNNING", "PASSED", "FAILED"]),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1).optional(),
  durationMs: z.number().nonnegative().optional(),
  sizeBytes: z.number().nonnegative().optional(),
  startLsn: z.string().optional(),
  endLsn: z.string().optional(),
  storageTargets: z.array(z.string()),
  errorMessage: z.string().optional(),
});

const drillCheckSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
});

const drillReportSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["PASSED", "FAILED"]),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1),
  durationMs: z.number().nonnegative(),
  targetTime: z.string().min(1),
  replayedLsn: z.string(),
  doubleEntryDrift: z.union([z.string(), z.number()]).transform(String),
  balanceMismatches: z.number().int().nonnegative(),
  auditBrokenLinks: z.number().int().nonnegative(),
  journalLineCount: z.number().int().nonnegative(),
  checks: z.object({
    doubleEntry: drillCheckSchema,
    balanceParity: drillCheckSchema,
    auditChain: drillCheckSchema,
  }),
  errorMessage: z.string().optional(),
  reportSignature: z.string().optional(),
});

const backupPolicySchema = z.object({
  fullCron: z.string().min(1),
  deltaCron: z.string().min(1),
  drillCron: z.string().min(1),
  fullRetentionDays: z.number().int().positive(),
  walRetentionDays: z.number().int().positive(),
  alertLagSeconds: z.number().int().positive(),
  updatedAt: z.string().min(1),
  updatedBy: z.string().optional(),
});

const backupCatalogSchema = z.object({
  runs: z.array(backupRunSchema).default([]),
  drills: z.array(drillReportSchema).default([]),
  policy: backupPolicySchema,
});

const clone = <T>(value: T): T => structuredClone(value);

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";

/**
 * A JSON catalog with atomic replace-on-write semantics. A corrupt or
 * unwritable file never takes the daemon down: the store keeps functioning
 * in-memory and reports the persistence failure to the caller.
 */
export class CatalogStore {
  private catalog: BackupCatalog;
  private readonly fileSystem: CatalogFileSystem;
  private readonly clock: () => Date;
  private readonly maxRuns: number;
  private readonly maxDrills: number;
  private writeChain: Promise<boolean> = Promise.resolve(true);
  private writeCounter = 0;
  private persistent = true;
  private persistenceError: string | undefined;
  private loadWarning: string | undefined;

  private constructor(
    private readonly path: string,
    catalog: BackupCatalog,
    options: CatalogStoreOptions,
  ) {
    this.catalog = catalog;
    this.fileSystem = options.fileSystem ?? defaultCatalogFileSystem;
    this.clock = options.clock ?? (() => new Date());
    this.maxRuns = options.maxRuns ?? 500;
    this.maxDrills = options.maxDrills ?? 100;
  }

  public static async load(options: CatalogStoreOptions): Promise<CatalogStore> {
    const fileSystem = options.fileSystem ?? defaultCatalogFileSystem;
    const defaultPolicy = options.defaultPolicy ?? createDefaultPolicy();
    let raw: string | undefined;
    let warning: string | undefined;

    try {
      raw = await fileSystem.readFile(options.path, "utf8");
    } catch (error) {
      if (!isNotFound(error)) {
        warning = `catalog could not be read: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    let parsed: BackupCatalog | undefined;
    if (raw !== undefined) {
      try {
        parsed = backupCatalogSchema.parse(JSON.parse(raw)) as BackupCatalog;
      } catch (error) {
        warning = `catalog is corrupt and was replaced in memory: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }

    const initial: BackupCatalog = parsed ?? {
      runs: [],
      drills: [],
      policy: defaultPolicy,
    };
    initial.runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    initial.drills.sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    const store = new CatalogStore(options.path, initial, options);
    store.loadWarning = warning;
    if (warning) {
      store.persistenceError = warning;
      if (raw === undefined) store.persistent = false;
      options.onWarning?.(warning);
    }
    if (raw === undefined && warning === undefined) {
      await store.save();
    } else if (warning !== undefined && raw !== undefined) {
      await store.save();
    }
    return store;
  }

  public snapshot(): BackupCatalog {
    return clone(this.catalog);
  }

  public getPolicy(): BackupPolicy {
    return clone(this.catalog.policy);
  }

  public listRuns(limit = 30): BackupRun[] {
    return clone(this.catalog.runs.slice(0, Math.max(0, limit)));
  }

  public listDrills(limit = 30): DrillReport[] {
    return clone(this.catalog.drills.slice(0, Math.max(0, limit)));
  }

  public latestDrill(): DrillReport | null {
    const latest = this.catalog.drills[0];
    return latest ? clone(latest) : null;
  }

  public async addRun(run: BackupRun): Promise<BackupRun> {
    this.catalog.runs.unshift(clone(run));
    this.prune();
    await this.save();
    return clone(run);
  }

  public async updateRun(id: string, patch: Partial<BackupRun>): Promise<BackupRun | null> {
    const index = this.catalog.runs.findIndex((run) => run.id === id);
    if (index === -1) return null;
    const current = this.catalog.runs[index];
    if (!current) return null;
    const updated = { ...current, ...patch, id: current.id };
    this.catalog.runs[index] = updated;
    await this.save();
    return clone(updated);
  }

  public async addDrill(report: DrillReport): Promise<DrillReport> {
    this.catalog.drills.unshift(clone(report));
    this.prune();
    await this.save();
    return clone(report);
  }

  public async updatePolicy(patch: Partial<BackupPolicy>): Promise<BackupPolicy> {
    this.catalog.policy = {
      ...this.catalog.policy,
      ...patch,
      updatedAt: patch.updatedAt ?? this.clock().toISOString(),
    };
    await this.save();
    return clone(this.catalog.policy);
  }

  public isPersistent(): boolean {
    return this.persistent;
  }

  public getPersistenceError(): string | undefined {
    return this.persistenceError;
  }

  public getLoadWarning(): string | undefined {
    return this.loadWarning;
  }

  public async save(): Promise<boolean> {
    const payload = `${JSON.stringify(this.catalog, null, 2)}\n`;
    this.writeChain = this.writeChain.then(() => this.writeAtomically(payload));
    return this.writeChain;
  }

  private prune(): void {
    if (this.catalog.runs.length > this.maxRuns) {
      this.catalog.runs = this.catalog.runs.slice(0, this.maxRuns);
    }
    if (this.catalog.drills.length > this.maxDrills) {
      this.catalog.drills = this.catalog.drills.slice(0, this.maxDrills);
    }
  }

  private async writeAtomically(payload: string): Promise<boolean> {
    this.writeCounter += 1;
    const directory = dirname(this.path);
    const tmpPath = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${this.writeCounter}.tmp`,
    );
    try {
      await this.fileSystem.mkdir(directory, { recursive: true });
      await this.fileSystem.writeFile(tmpPath, payload, "utf8");
      await this.fileSystem.rename(tmpPath, this.path);
      this.persistent = true;
      this.persistenceError = undefined;
      return true;
    } catch (error) {
      this.persistent = false;
      this.persistenceError = error instanceof Error ? error.message : String(error);
      try {
        await this.fileSystem.unlink(tmpPath);
      } catch {
        // The temporary file may never have been created.
      }
      return false;
    }
  }
}
