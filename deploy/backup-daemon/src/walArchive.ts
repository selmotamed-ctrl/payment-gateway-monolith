import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream, promises as nodeFs } from "node:fs";
import { join } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ArtifactRepository } from "./artifactStore";
import type { CommandRunner } from "./commandRunner";
import type { BackupDaemonConfig } from "./config";
import { HashPassThrough, openFile } from "./cryptoEnvelope";
import {
  buildCreateSlotCommand,
  buildReceiveWalCommand,
  runTool,
  type PgCluster,
  type ToolCommand,
} from "./pgTools";
import { sealIntoRepository } from "./repository";
import { errorMessage, sha256File, sleep } from "./util";
import { isArchivableWalFile, isWalSegmentName, isWalTarget, type WalTarget } from "./walNames";

export class WalIngestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WalIngestError";
  }
}

export const walKey = (target: WalTarget, file: string): string => `wal/${target}/${file}.zst.enc`;
const sealId = (_target: WalTarget, file: string): string => `wal/${file}`;

export interface WalTrackerState {
  lastArchivedWal: string;
  lastArchivedAt: string | null;
  received: number;
  duplicates: number;
  conflicts: number;
  lastError: string | null;
}

export interface WalArchiveDeps {
  config: BackupDaemonConfig;
  repository: ArtifactRepository;
  master: Buffer;
  clock?: () => Date;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export type IngestResult = { status: "stored" | "duplicate"; key: string; bytes: number };

/** Counts bytes and aborts the stream once `limit` is exceeded. */
class SizeLimit extends Transform {
  public bytes = 0;
  constructor(private readonly limit: number) {
    super();
  }
  public override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) return callback(new WalIngestError(413, "payload_too_large", `WAL file exceeds ${this.limit} bytes`));
    callback(null, chunk);
  }
}

/**
 * Receives WAL files (from `archive_command` over mTLS or from `pg_receivewal`)
 * and stores each one compressed + encrypted. The write is idempotent: the same
 * bytes uploaded again are acknowledged, different bytes for an existing name are
 * refused (409) so a segment in the archive can never be silently replaced.
 */
export class WalArchive {
  public readonly mirror: WalMirror;
  private readonly clock: () => Date;
  private readonly logger?: Pick<Console, "info" | "warn" | "error">;
  private readonly tracker: WalTrackerState = {
    lastArchivedWal: "",
    lastArchivedAt: null,
    received: 0,
    duplicates: 0,
    conflicts: 0,
    lastError: null,
  };
  private readonly inFlight = new Map<string, Promise<IngestResult>>();

  constructor(private readonly deps: WalArchiveDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.logger = deps.logger;
    this.mirror = new WalMirror(deps.repository, deps.config.BACKUP_STAGING_DIR, deps.logger);
  }

  public state(): WalTrackerState {
    return { ...this.tracker };
  }

  private get primaryIds(): string[] {
    const first = this.deps.repository.stores[0];
    return first ? [first.id] : [];
  }

  public validate(target: string, file: string): WalTarget {
    if (!isWalTarget(target)) throw new WalIngestError(400, "invalid_wal_target", "target must be postgres_core or audit_db");
    if (!isArchivableWalFile(file)) throw new WalIngestError(400, "invalid_wal_file", "not a WAL segment, timeline history or backup label file name");
    return target;
  }

  /** Streams a request body into a staging file (size capped), then stores it. */
  public async ingestStream(target: string, file: string, body: Readable, declaredLength: number | null): Promise<IngestResult> {
    const walTarget = this.validate(target, file);
    const limit = this.deps.config.BACKUP_WAL_PUSH_MAX_BYTES;
    if (declaredLength !== null && declaredLength > limit) {
      throw new WalIngestError(413, "payload_too_large", `WAL file exceeds ${limit} bytes`);
    }
    const staging = join(this.deps.config.BACKUP_STAGING_DIR, "wal-in");
    await nodeFs.mkdir(staging, { recursive: true, mode: 0o700 });
    const incoming = join(staging, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${file}`);
    try {
      await pipeline(body, new SizeLimit(limit), createWriteStream(incoming, { mode: 0o600 }));
      const size = (await nodeFs.stat(incoming)).size;
      if (size === 0) throw new WalIngestError(400, "empty_wal_file", "empty WAL upload");
      if (declaredLength !== null && declaredLength !== size) {
        throw new WalIngestError(400, "truncated_upload", "uploaded size does not match Content-Length");
      }
      return await this.ingestFile(walTarget, file, incoming);
    } finally {
      await nodeFs.rm(incoming, { force: true }).catch(() => undefined);
    }
  }

  /** Stores a WAL file that is already on disk (also used by the pg_receivewal sweeper). */
  public ingestFile(target: WalTarget, file: string, path: string): Promise<IngestResult> {
    const key = walKey(target, file);
    // Two simultaneous uploads of the same name must not race each other.
    const running = this.inFlight.get(key);
    if (running) return running.then(() => this.ingestFile(target, file, path));
    const task = this.doIngest(target, file, path, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async doIngest(target: WalTarget, file: string, path: string, key: string): Promise<IngestResult> {
    const { repository, master, config } = this.deps;
    try {
      const plainSha = await sha256File(path);
      const size = (await nodeFs.stat(path)).size;
      const existing = await this.existingPlaintextSha(target, file, key);
      if (existing !== null) {
        if (existing === plainSha) {
          this.tracker.duplicates += 1;
          this.touch(file);
          return { status: "duplicate", key, bytes: size };
        }
        this.tracker.conflicts += 1;
        this.logger?.error(`[pg-backup-daemon] WAL conflict: ${key} already exists with different content; refusing to overwrite`);
        throw new WalIngestError(409, "wal_conflict", `${file} already archived with different content`);
      }
      await sealIntoRepository(repository, key, createReadStream(path), {
        master,
        target: `wal:${target}`,
        id: sealId(target, file),
        stagingDir: config.BACKUP_STAGING_DIR,
        onlyIds: this.primaryIds,
      });
      this.tracker.received += 1;
      this.touch(file);
      this.mirror.schedule(key);
      return { status: "stored", key, bytes: size };
    } catch (error) {
      if (!(error instanceof WalIngestError)) this.tracker.lastError = errorMessage(error).slice(0, 300);
      throw error;
    }
  }

  private touch(file: string): void {
    if (isWalSegmentName(file) && file > this.tracker.lastArchivedWal) this.tracker.lastArchivedWal = file;
    this.tracker.lastArchivedAt = this.clock().toISOString();
    this.tracker.lastError = null;
  }

  /** SHA-256 of the stored plaintext, or null when the file has not been archived yet. */
  private async existingPlaintextSha(target: WalTarget, file: string, key: string): Promise<string | null> {
    const { repository, master, config } = this.deps;
    const primary = repository.stores[0];
    if (!primary || !(await primary.exists(key))) return null;
    const tmp = join(config.BACKUP_STAGING_DIR, "wal-in", `existing-${process.pid}-${Date.now()}-${file}`);
    try {
      await primary.getFile(key, tmp);
      const hash = new HashPassThrough();
      await pipeline(openFile(tmp, { master, target: `wal:${target}`, id: sealId(target, file) }), hash, new Transform({ transform: (_c, _e, cb) => cb() }));
      return hash.sha256;
    } finally {
      await nodeFs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Asynchronous mirroring of WAL to the non-primary tiers
// ---------------------------------------------------------------------------

export class WalMirror {
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  public lastError: string | null = null;
  public mirrored = 0;

  constructor(
    private readonly repository: ArtifactRepository,
    private readonly stagingDir: string,
    private readonly logger?: Pick<Console, "info" | "warn" | "error">,
  ) {}

  public pendingCount(): number {
    return this.pending.size;
  }

  public schedule(key: string): void {
    if (this.repository.stores.length < 2) return;
    this.pending.add(key);
    void this.drainOnce();
  }

  public start(intervalMs = 30_000): void {
    if (this.timer || this.repository.stores.length < 2) return;
    this.timer = setInterval(() => {
      void this.reconcile().then(() => this.drainOnce()).catch((error) => {
        this.lastError = errorMessage(error);
      });
    }, intervalMs);
    // The reconcile pass also runs once at start so a restart picks up WAL that never got mirrored.
    void this.reconcile().then(() => this.drainOnce()).catch(() => undefined);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Queues every WAL object that exists on the primary tier but not on a mirror tier. */
  public async reconcile(): Promise<number> {
    const listings = await this.repository.listByStore("wal");
    const primary = this.repository.stores[0];
    const source = primary ? listings.get(primary.id) : undefined;
    if (!source) return 0;
    let queued = 0;
    for (const store of this.repository.stores.slice(1)) {
      const have = listings.get(store.id);
      if (!have) continue;
      for (const key of source) {
        if (!have.has(key) && !this.pending.has(key)) {
          this.pending.add(key);
          queued += 1;
        }
      }
    }
    return queued;
  }

  public async drainOnce(): Promise<{ mirrored: number; failed: number }> {
    if (this.running) return { mirrored: 0, failed: 0 };
    this.running = true;
    let mirrored = 0;
    let failed = 0;
    try {
      const primary = this.repository.stores[0];
      if (!primary) return { mirrored, failed };
      for (const key of [...this.pending]) {
        let source: string;
        let temporary = false;
        const local = this.repository.local;
        if (local && primary.id === local.id) {
          source = local.pathFor(key);
        } else {
          source = join(this.stagingDir, `mirror-${process.pid}-${Date.now()}.tmp`);
          temporary = true;
          await primary.getFile(key, source);
        }
        try {
          let allMirrored = true;
          for (const store of this.repository.stores.slice(1)) {
            try {
              if (!(await store.exists(key))) await store.putFile(key, source);
            } catch (error) {
              allMirrored = false;
              failed += 1;
              this.lastError = `${store.id}: ${errorMessage(error).slice(0, 200)}`;
              this.logger?.warn(`[pg-backup-daemon] WAL mirror to ${store.id} failed for ${key}: ${this.lastError}`);
            }
          }
          if (allMirrored) {
            this.pending.delete(key);
            mirrored += 1;
            this.mirrored += 1;
          }
        } finally {
          if (temporary) await nodeFs.rm(source, { force: true }).catch(() => undefined);
        }
      }
    } catch (error) {
      this.lastError = errorMessage(error).slice(0, 200);
    } finally {
      this.running = false;
    }
    return { mirrored, failed };
  }
}

// ---------------------------------------------------------------------------
// pg_receivewal supervisor: the continuous (near zero RPO) WAL path
// ---------------------------------------------------------------------------

export type SpawnFn = (command: string, args: string[], env: Record<string, string>) => ChildProcess;

const defaultSpawn: SpawnFn = (command, args, env) =>
  spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });

export interface WalStreamerOptions {
  config: BackupDaemonConfig;
  runner: CommandRunner;
  archive: WalArchive;
  cluster: PgCluster;
  target: WalTarget;
  slot: string;
  spoolDir: string;
  spawnFn?: SpawnFn;
  sweepIntervalMs?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface WalStreamerStatus {
  target: WalTarget;
  running: boolean;
  restarts: number;
  startedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
  swept: number;
}

/**
 * Keeps one `pg_receivewal` alive against a persistent replication slot, writing
 * WAL into a private spool the moment PostgreSQL produces it (`--synchronous`).
 * Completed segments are encrypted into the repository and removed from the
 * spool; the `.partial` file of the segment being written stays, so recovery
 * can even use the newest, not-yet-switched WAL (see walFetch).
 */
export class WalStreamer {
  private child: ChildProcess | undefined;
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private stopped = true;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private readonly spawnFn: SpawnFn;
  private readonly status: WalStreamerStatus;
  private sweeping = false;

  constructor(private readonly options: WalStreamerOptions) {
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.status = {
      target: options.target,
      running: false,
      restarts: 0,
      startedAt: null,
      lastExitCode: null,
      lastError: null,
      swept: 0,
    };
  }

  public getStatus(): WalStreamerStatus {
    return { ...this.status };
  }

  public async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await nodeFs.mkdir(this.options.spoolDir, { recursive: true, mode: 0o700 });
    this.sweeper = setInterval(() => void this.sweepOnce().catch(() => undefined), this.options.sweepIntervalMs ?? 5_000);
    this.loop = this.supervise();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    if (this.child && this.child.exitCode === null) this.child.kill("SIGTERM");
    await this.loop?.catch(() => undefined);
    await this.sweepOnce().catch(() => undefined);
  }

  private async ensureSlot(): Promise<void> {
    const { config, runner, cluster, slot } = this.options;
    await runTool(runner, buildCreateSlotCommand(config, cluster, slot), `pg_receivewal --create-slot ${slot}`);
  }

  private async supervise(): Promise<void> {
    let backoff = 1_000;
    while (!this.stopped) {
      try {
        await this.ensureSlot();
        const command: ToolCommand = buildReceiveWalCommand(this.options.config, this.options.cluster, this.options.spoolDir, this.options.slot);
        const exit = await this.runOnce(command);
        this.status.lastExitCode = exit.code;
        if (!this.stopped) {
          this.status.lastError = exit.stderr.trim().slice(-300) || `pg_receivewal exited with code ${exit.code}`;
          this.options.logger?.warn(`[pg-backup-daemon] pg_receivewal (${this.options.target}) exited: ${this.status.lastError}`);
        }
        backoff = exit.ranFor > 30_000 ? 1_000 : Math.min(backoff * 2, 30_000);
      } catch (error) {
        this.status.lastError = errorMessage(error).slice(0, 300);
        this.options.logger?.warn(`[pg-backup-daemon] WAL streaming (${this.options.target}) could not start: ${this.status.lastError}`);
        backoff = Math.min(backoff * 2, 30_000);
      }
      this.status.running = false;
      if (this.stopped) break;
      this.status.restarts += 1;
      // Interruptible, so stop() never waits out a 30 s backoff.
      await Promise.race([
        sleep(backoff),
        new Promise<void>((resolve) => {
          this.wake = resolve;
        }),
      ]);
      this.wake = undefined;
    }
  }

  private runOnce(command: ToolCommand): Promise<{ code: number; stderr: string; ranFor: number }> {
    return new Promise((resolve) => {
      const startedMs = Date.now();
      const child = this.spawnFn(command.command, command.args, command.env);
      this.child = child;
      this.status.running = true;
      this.status.startedAt = new Date(startedMs).toISOString();
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2000);
      });
      child.on("error", (error) => {
        stderr += error.message;
        resolve({ code: 127, stderr, ranFor: Date.now() - startedMs });
      });
      child.on("close", (code) => resolve({ code: code ?? 1, stderr, ranFor: Date.now() - startedMs }));
    });
  }

  /** Moves finished spool files into the repository. Exposed for tests and shutdown. */
  public async sweepOnce(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let moved = 0;
    try {
      let names: string[];
      try {
        names = await nodeFs.readdir(this.options.spoolDir);
      } catch {
        return 0;
      }
      for (const name of names.sort()) {
        if (!isArchivableWalFile(name)) continue;
        const path = join(this.options.spoolDir, name);
        try {
          await this.options.archive.ingestFile(this.options.target, name, path);
          await nodeFs.rm(path, { force: true });
          moved += 1;
          this.status.swept += 1;
        } catch (error) {
          if (error instanceof WalIngestError && error.status === 409) {
            // The archive already holds a different version of this segment; keep ours aside for forensics.
            await nodeFs.mkdir(join(this.options.spoolDir, "conflicts"), { recursive: true, mode: 0o700 });
            await nodeFs.rename(path, join(this.options.spoolDir, "conflicts", name)).catch(() => undefined);
          } else {
            this.status.lastError = errorMessage(error).slice(0, 300);
          }
        }
      }
    } finally {
      this.sweeping = false;
    }
    return moved;
  }
}
