import { createReadStream, createWriteStream, promises as nodeFs } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { CommandRunner } from "./commandRunner";
import { errorMessage, isNotFound, sha256File, tempSibling } from "./util";

/**
 * The 3-2-1 storage pipeline. Every artifact is addressed by a relative,
 * forward-slash key (`backups/postgres_core/<id>.tar.zst.enc`, `wal/postgres_core/<segment>.zst.enc`, ...)
 * that means the same thing on every tier, so any tier can serve a restore.
 */
export type ArtifactStoreKind = "local" | "s3" | "ssh";

export interface StoreHealth {
  healthy: boolean;
  detail: string;
}

export interface ArtifactStore {
  readonly id: string;
  readonly name: string;
  readonly kind: ArtifactStoreKind;
  /** When false the store never deletes (append-only off-site vault). */
  readonly allowDelete: boolean;
  putFile(key: string, localPath: string): Promise<void>;
  putBuffer(key: string, data: Uint8Array): Promise<void>;
  getFile(key: string, destPath: string): Promise<void>;
  getBuffer(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
  health(): Promise<StoreHealth>;
}

const KEY_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export const assertSafeKey = (key: string): string => {
  if (!KEY_PATTERN.test(key) || key.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`unsafe artifact key: ${JSON.stringify(key).slice(0, 120)}`);
  }
  return key;
};

// ---------------------------------------------------------------------------
// Tier 1: local content repository
// ---------------------------------------------------------------------------

export class LocalRepoStore implements ArtifactStore {
  public readonly id = "local-repo";
  public readonly name = "Local Repository";
  public readonly kind = "local" as const;
  public readonly allowDelete = true;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Absolute path of a key (validated to stay inside the repository root). */
  public pathFor(key: string): string {
    const full = resolve(this.root, assertSafeKey(key));
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error("artifact key escapes the repository");
    return full;
  }

  public async putFile(key: string, localPath: string): Promise<void> {
    const dest = this.pathFor(key);
    if (resolve(localPath) === dest) return;
    await nodeFs.mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = tempSibling(dest);
    try {
      await pipeline(createReadStream(localPath), createWriteStream(tmp, { mode: 0o600 }));
      await nodeFs.rename(tmp, dest);
    } catch (error) {
      await nodeFs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async putBuffer(key: string, data: Uint8Array): Promise<void> {
    const dest = this.pathFor(key);
    await nodeFs.mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = tempSibling(dest);
    try {
      await nodeFs.writeFile(tmp, data, { mode: 0o600 });
      await nodeFs.rename(tmp, dest);
    } catch (error) {
      await nodeFs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async getFile(key: string, destPath: string): Promise<void> {
    const source = this.pathFor(key);
    if (resolve(destPath) === source) return;
    await nodeFs.mkdir(dirname(destPath), { recursive: true });
    await pipeline(createReadStream(source), createWriteStream(destPath, { mode: 0o600 }));
  }

  public async getBuffer(key: string): Promise<Buffer | null> {
    try {
      return await nodeFs.readFile(this.pathFor(key));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  public async exists(key: string): Promise<boolean> {
    try {
      await nodeFs.access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  public async list(prefix: string): Promise<string[]> {
    const base = prefix ? this.pathFor(prefix.replace(/\/+$/, "")) : this.root;
    const keys: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await nodeFs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) keys.push(relative(this.root, full).split(sep).join("/"));
      }
    };
    await walk(base);
    return keys.sort();
  }

  public async delete(key: string): Promise<void> {
    await nodeFs.rm(this.pathFor(key), { force: true });
  }

  public async health(): Promise<StoreHealth> {
    try {
      await nodeFs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const probe = join(this.root, `.health-${process.pid}.tmp`);
      await nodeFs.writeFile(probe, "ok");
      await nodeFs.rm(probe, { force: true });
      const stats = await nodeFs.statfs(this.root);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      return { healthy: true, detail: `writable, ${Math.floor(freeBytes / (1024 * 1024))} MiB free` };
    } catch (error) {
      return { healthy: false, detail: errorMessage(error) };
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 2: S3 / MinIO / R2 (Bun's native SigV4 client)
// ---------------------------------------------------------------------------

export interface S3ObjectLike {
  exists(): Promise<boolean>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface S3ListResult {
  contents?: Array<{ key: string }>;
  isTruncated?: boolean;
  nextContinuationToken?: string;
}

export interface S3ClientLike {
  write(key: string, data: unknown): Promise<number>;
  file(key: string): S3ObjectLike & { stream?: () => ReadableStream<Uint8Array> };
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(input?: { prefix?: string; continuationToken?: string; maxKeys?: number }): Promise<S3ListResult>;
}

export interface ParsedBucket {
  bucket: string;
  prefix: string;
}

/** `s3://bucket/some/prefix` or a bare `bucket` name. */
export const parseBucketSpec = (value: string): ParsedBucket => {
  const stripped = value.trim().replace(/^s3:\/\//, "");
  const [bucket = "", ...rest] = stripped.split("/");
  return { bucket, prefix: rest.filter(Boolean).join("/") };
};

export interface S3StoreOptions {
  endpoint: string;
  bucketSpec: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  client?: S3ClientLike;
}

export class S3ObjectStore implements ArtifactStore {
  public readonly id = "primary-s3";
  public readonly name = "Primary S3 Bucket";
  public readonly kind = "s3" as const;
  public readonly allowDelete = true;
  private readonly client: S3ClientLike;
  private readonly prefix: string;

  constructor(options: S3StoreOptions) {
    const parsed = parseBucketSpec(options.bucketSpec);
    this.prefix = parsed.prefix;
    this.client =
      options.client ??
      (new Bun.S3Client({
        endpoint: options.endpoint,
        bucket: parsed.bucket,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        region: options.region ?? "us-east-1",
        virtualHostedStyle: false,
      }) as unknown as S3ClientLike);
  }

  private full(key: string): string {
    return this.prefix ? `${this.prefix}/${assertSafeKey(key)}` : assertSafeKey(key);
  }

  public async putFile(key: string, localPath: string): Promise<void> {
    await this.client.write(this.full(key), Bun.file(localPath));
  }

  public async putBuffer(key: string, data: Uint8Array): Promise<void> {
    await this.client.write(this.full(key), data);
  }

  public async getFile(key: string, destPath: string): Promise<void> {
    await nodeFs.mkdir(dirname(destPath), { recursive: true });
    const tmp = tempSibling(destPath);
    try {
      const object = this.client.file(this.full(key));
      if (typeof object.stream === "function") {
        await pipeline(
          (await import("node:stream")).Readable.fromWeb(object.stream() as never),
          createWriteStream(tmp, { mode: 0o600 }),
        );
      } else {
        await nodeFs.writeFile(tmp, Buffer.from(await object.arrayBuffer()), { mode: 0o600 });
      }
      await nodeFs.rename(tmp, destPath);
    } catch (error) {
      await nodeFs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async getBuffer(key: string): Promise<Buffer | null> {
    const object = this.client.file(this.full(key));
    if (!(await object.exists())) return null;
    return Buffer.from(await object.arrayBuffer());
  }

  public async exists(key: string): Promise<boolean> {
    return this.client.exists(this.full(key));
  }

  public async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    const clean = prefix.replace(/\/+$/, "");
    if (clean) assertSafeKey(clean);
    const base = [this.prefix, clean].filter(Boolean).join("/");
    const listPrefix = base ? `${base}/` : "";
    const strip = this.prefix ? `${this.prefix}/` : "";
    let token: string | undefined;
    do {
      const page = await this.client.list({ prefix: listPrefix, continuationToken: token, maxKeys: 1000 });
      for (const entry of page.contents ?? []) {
        keys.push(strip && entry.key.startsWith(strip) ? entry.key.slice(strip.length) : entry.key);
      }
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  public async delete(key: string): Promise<void> {
    await this.client.delete(this.full(key));
  }

  public async health(): Promise<StoreHealth> {
    try {
      const probeKey = `.health/${process.pid}`;
      await this.client.write(this.full(probeKey), "ok");
      const present = await this.client.exists(this.full(probeKey));
      await this.client.delete(this.full(probeKey));
      return present
        ? { healthy: true, detail: "reachable (write/read/delete verified)" }
        : { healthy: false, detail: "write succeeded but the object could not be read back" };
    } catch (error) {
      return { healthy: false, detail: errorMessage(error).slice(0, 300) };
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 3: off-site vault (ssh/rsync with remote sha256 verification, or rclone)
// ---------------------------------------------------------------------------

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export interface VaultStoreOptions {
  target: string;
  runner: CommandRunner;
  allowDelete: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export class VaultStore implements ArtifactStore {
  public readonly id = "secondary-ssh";
  public readonly name = "Secondary Off-site Target";
  public readonly kind = "ssh" as const;
  public readonly allowDelete: boolean;
  private readonly mode: "rclone" | "ssh";
  private readonly remote: string;
  private readonly host: string;
  private readonly basePath: string;

  constructor(private readonly options: VaultStoreOptions) {
    this.allowDelete = options.allowDelete;
    const target = options.target.trim();
    if (target.startsWith("s3://") || target.startsWith("rclone:")) {
      this.mode = "rclone";
      this.remote = (target.startsWith("rclone:") ? target.slice("rclone:".length) : target).replace(/\/+$/, "");
      this.host = "";
      this.basePath = "";
    } else {
      this.mode = "ssh";
      const split = target.lastIndexOf(":");
      if (split <= 0) throw new Error("BACKUP_SECONDARY_SSH_TARGET must look like user@host:/path, s3://... or rclone:remote:path");
      this.host = target.slice(0, split);
      this.basePath = target.slice(split + 1).replace(/\/+$/, "");
      this.remote = target;
    }
  }

  private run(command: string, args: string[], input?: string) {
    return this.options.runner.run(command, args, {
      env: this.options.env,
      timeoutMs: this.options.timeoutMs,
      ...(input === undefined ? {} : { input }),
    });
  }

  private remotePath(key: string): string {
    return `${this.basePath}/${assertSafeKey(key)}`;
  }

  private sshArgs(): string[] {
    return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  }

  private async ssh(script: string) {
    return this.run("ssh", [...this.sshArgs(), this.host, script]);
  }

  public async putFile(key: string, localPath: string): Promise<void> {
    if (this.mode === "rclone") {
      const result = await this.run("rclone", ["copyto", localPath, `${this.remote}/${assertSafeKey(key)}`]);
      if (result.code !== 0) throw new Error(`rclone copyto failed: ${result.stderr.trim().slice(0, 300)}`);
      return;
    }
    const remotePath = this.remotePath(key);
    const mkdir = await this.ssh(`mkdir -p ${shellQuote(posix.dirname(remotePath))}`);
    if (mkdir.code !== 0) throw new Error(`ssh mkdir failed: ${mkdir.stderr.trim().slice(0, 300)}`);
    const sync = await this.run("rsync", [
      "-a",
      "--partial",
      "-e",
      `ssh ${this.sshArgs().join(" ")}`,
      localPath,
      `${this.host}:${remotePath}`,
    ]);
    if (sync.code !== 0) throw new Error(`rsync failed: ${sync.stderr.trim().slice(0, 300)}`);
    // Never trust the transfer: compare the remote SHA-256 with the local file.
    const expected = await sha256File(localPath);
    const remote = await this.ssh(`sha256sum ${shellQuote(remotePath)}`);
    const actual = remote.stdout.trim().split(/\s+/)[0];
    if (remote.code !== 0 || actual !== expected) {
      throw new Error(`off-site checksum mismatch for ${key} (expected ${expected.slice(0, 12)}..., got ${(actual ?? "none").slice(0, 12)}...)`);
    }
  }

  public async putBuffer(key: string, data: Uint8Array): Promise<void> {
    const tmp = tempSibling(`/tmp/pg-backup-vault-${process.pid}`);
    await nodeFs.writeFile(tmp, data, { mode: 0o600 });
    try {
      await this.putFile(key, tmp);
    } finally {
      await nodeFs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  public async getFile(key: string, destPath: string): Promise<void> {
    await nodeFs.mkdir(dirname(destPath), { recursive: true });
    const result =
      this.mode === "rclone"
        ? await this.run("rclone", ["copyto", `${this.remote}/${assertSafeKey(key)}`, destPath])
        : await this.run("rsync", ["-a", "-e", `ssh ${this.sshArgs().join(" ")}`, `${this.host}:${this.remotePath(key)}`, destPath]);
    if (result.code !== 0) throw new Error(`off-site fetch failed: ${result.stderr.trim().slice(0, 300)}`);
  }

  public async getBuffer(key: string): Promise<Buffer | null> {
    if (!(await this.exists(key))) return null;
    const tmp = tempSibling(`/tmp/pg-backup-vault-get-${process.pid}`);
    try {
      await this.getFile(key, tmp);
      return await nodeFs.readFile(tmp);
    } finally {
      await nodeFs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  public async exists(key: string): Promise<boolean> {
    const result =
      this.mode === "rclone"
        ? await this.run("rclone", ["lsf", `${this.remote}/${assertSafeKey(key)}`])
        : await this.ssh(`test -f ${shellQuote(this.remotePath(key))}`);
    return result.code === 0 && (this.mode === "ssh" || result.stdout.trim().length > 0);
  }

  public async list(prefix: string): Promise<string[]> {
    const clean = prefix.replace(/\/+$/, "");
    if (this.mode === "rclone") {
      const result = await this.run("rclone", ["lsf", "-R", "--files-only", `${this.remote}${clean ? `/${clean}` : ""}`]);
      if (result.code !== 0) return [];
      return result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((entry) => (clean ? `${clean}/${entry}` : entry))
        .sort();
    }
    const base = clean ? `${this.basePath}/${assertSafeKey(clean)}` : this.basePath;
    const result = await this.ssh(`[ -d ${shellQuote(base)} ] && cd ${shellQuote(this.basePath)} && find ${shellQuote(clean || ".")} -type f -not -name '.*.tmp' | sed 's|^\\./||'`);
    if (result.code !== 0) return [];
    return result.stdout.split(/\r?\n/).filter(Boolean).sort();
  }

  public async delete(key: string): Promise<void> {
    if (!this.allowDelete) return;
    const result =
      this.mode === "rclone"
        ? await this.run("rclone", ["deletefile", `${this.remote}/${assertSafeKey(key)}`])
        : await this.ssh(`rm -f ${shellQuote(this.remotePath(key))}`);
    if (result.code !== 0) throw new Error(`off-site delete failed: ${result.stderr.trim().slice(0, 300)}`);
  }

  public async health(): Promise<StoreHealth> {
    try {
      const result =
        this.mode === "rclone"
          ? await this.run("rclone", ["lsd", this.remote])
          : await this.ssh(`mkdir -p ${shellQuote(this.basePath)} && test -w ${shellQuote(this.basePath)}`);
      return result.code === 0
        ? { healthy: true, detail: "reachable" }
        : { healthy: false, detail: (result.stderr || result.stdout || `exit code ${result.code}`).trim().slice(0, 300) };
    } catch (error) {
      return { healthy: false, detail: errorMessage(error).slice(0, 300) };
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory store (tests, dry runs)
// ---------------------------------------------------------------------------

export class MemoryArtifactStore implements ArtifactStore {
  public readonly kind: ArtifactStoreKind;
  public readonly objects = new Map<string, Buffer>();
  public failPuts = false;

  constructor(
    public readonly id: string,
    public readonly name: string = id,
    kind: ArtifactStoreKind = "s3",
    public readonly allowDelete = true,
  ) {
    this.kind = kind;
  }

  public async putFile(key: string, localPath: string): Promise<void> {
    if (this.failPuts) throw new Error(`${this.id} is unavailable`);
    this.objects.set(assertSafeKey(key), await nodeFs.readFile(localPath));
  }

  public async putBuffer(key: string, data: Uint8Array): Promise<void> {
    if (this.failPuts) throw new Error(`${this.id} is unavailable`);
    this.objects.set(assertSafeKey(key), Buffer.from(data));
  }

  public async getFile(key: string, destPath: string): Promise<void> {
    const value = this.objects.get(assertSafeKey(key));
    if (!value) throw new Error(`${key} not found in ${this.id}`);
    await nodeFs.mkdir(dirname(destPath), { recursive: true });
    await nodeFs.writeFile(destPath, value);
  }

  public async getBuffer(key: string): Promise<Buffer | null> {
    return this.objects.get(assertSafeKey(key)) ?? null;
  }

  public async exists(key: string): Promise<boolean> {
    return this.objects.has(assertSafeKey(key));
  }

  public async list(prefix: string): Promise<string[]> {
    const normalized = prefix.replace(/\/+$/, "");
    return [...this.objects.keys()].filter((key) => !normalized || key.startsWith(`${normalized}/`)).sort();
  }

  public async delete(key: string): Promise<void> {
    if (this.allowDelete) this.objects.delete(assertSafeKey(key));
  }

  public async health(): Promise<StoreHealth> {
    return this.failPuts ? { healthy: false, detail: "unavailable" } : { healthy: true, detail: "reachable" };
  }
}

// ---------------------------------------------------------------------------
// Multi-tier repository
// ---------------------------------------------------------------------------

export interface PutOutcome {
  stored: string[];
  failed: Array<{ id: string; error: string }>;
}

export class RepositoryWriteError extends Error {
  constructor(
    message: string,
    public readonly outcome: PutOutcome,
  ) {
    super(message);
    this.name = "RepositoryWriteError";
  }
}

export interface ArtifactRepositoryOptions {
  /** Tiers whose failure fails the write. The rest (the off-site vault) are best effort. */
  requiredIds?: string[];
}

/**
 * Writes fan out to every tier; reads try tiers in order. Local (tier 1) and
 * S3 (tier 2) are required: an artifact that is not on both is not a 3-2-1
 * backup and the run fails. The append-only off-site vault is best effort so a
 * flaky link cannot turn a good backup into a failed one.
 */
export class ArtifactRepository {
  private readonly requiredIds: Set<string>;

  constructor(
    public readonly stores: ArtifactStore[],
    options: ArtifactRepositoryOptions = {},
  ) {
    if (stores.length === 0) throw new Error("at least one artifact store (local repository or S3) is required");
    this.requiredIds = new Set(options.requiredIds ?? stores.filter((store) => store.kind !== "ssh").map((store) => store.id));
  }

  public get local(): LocalRepoStore | undefined {
    return this.stores.find((store): store is LocalRepoStore => store instanceof LocalRepoStore);
  }

  public async putFile(key: string, localPath: string, onlyIds?: string[]): Promise<PutOutcome> {
    const outcome: PutOutcome = { stored: [], failed: [] };
    const targets = this.stores.filter((store) => !onlyIds || onlyIds.includes(store.id));
    const results = await Promise.allSettled(targets.map((store) => store.putFile(key, localPath)));
    results.forEach((result, index) => {
      const store = targets[index]!;
      if (result.status === "fulfilled") outcome.stored.push(store.id);
      else outcome.failed.push({ id: store.id, error: errorMessage(result.reason).slice(0, 300) });
    });
    const requiredFailure = outcome.failed.find((entry) => this.requiredIds.has(entry.id));
    if (requiredFailure) {
      throw new RepositoryWriteError(`storing ${key} on ${requiredFailure.id} failed: ${requiredFailure.error}`, outcome);
    }
    return outcome;
  }

  public async putBuffer(key: string, data: Uint8Array, onlyIds?: string[]): Promise<PutOutcome> {
    const outcome: PutOutcome = { stored: [], failed: [] };
    const targets = this.stores.filter((store) => !onlyIds || onlyIds.includes(store.id));
    const results = await Promise.allSettled(targets.map((store) => store.putBuffer(key, data)));
    results.forEach((result, index) => {
      const store = targets[index]!;
      if (result.status === "fulfilled") outcome.stored.push(store.id);
      else outcome.failed.push({ id: store.id, error: errorMessage(result.reason).slice(0, 300) });
    });
    const requiredFailure = outcome.failed.find((entry) => this.requiredIds.has(entry.id));
    if (requiredFailure) {
      throw new RepositoryWriteError(`storing ${key} on ${requiredFailure.id} failed: ${requiredFailure.error}`, outcome);
    }
    return outcome;
  }

  /** Downloads from the first tier that has the artifact; returns that tier's id. */
  public async getFile(key: string, destPath: string): Promise<string> {
    const errors: string[] = [];
    for (const store of this.stores) {
      try {
        if (!(await store.exists(key))) continue;
        await store.getFile(key, destPath);
        return store.id;
      } catch (error) {
        errors.push(`${store.id}: ${errorMessage(error).slice(0, 200)}`);
      }
    }
    throw new Error(`artifact ${key} is not available on any storage tier${errors.length > 0 ? ` (${errors.join("; ")})` : ""}`);
  }

  /**
   * Like getFile, but a copy that fails `verify` (e.g. its SHA-256 does not match the signed manifest)
   * is discarded and the NEXT tier is tried. A bit-rotted local copy must not stop a restore that a
   * good copy on S3 or the off-site vault could serve. Throws only when no tier has a verified copy.
   */
  public async getFileVerified(key: string, destPath: string, verify: (path: string) => Promise<void>): Promise<string> {
    const errors: string[] = [];
    for (const store of this.stores) {
      try {
        if (!(await store.exists(key))) continue;
        await store.getFile(key, destPath);
        await verify(destPath);
        return store.id;
      } catch (error) {
        errors.push(`${store.id}: ${errorMessage(error).slice(0, 200)}`);
        await nodeFs.rm(destPath, { force: true }).catch(() => undefined);
      }
    }
    throw new Error(
      `artifact ${key} is missing or failed verification on every storage tier${errors.length > 0 ? ` (${errors.join("; ")})` : ""}`,
    );
  }

  public async getBuffer(key: string): Promise<Buffer | null> {
    for (const store of this.stores) {
      try {
        const value = await store.getBuffer(key);
        if (value) return value;
      } catch {
        // try the next tier
      }
    }
    return null;
  }

  /** Union of keys across tiers. */
  public async list(prefix: string): Promise<string[]> {
    const keys = new Set<string>();
    const results = await Promise.allSettled(this.stores.map((store) => store.list(prefix)));
    for (const result of results) {
      if (result.status === "fulfilled") for (const key of result.value) keys.add(key);
    }
    return [...keys].sort();
  }

  /** Per-tier listing, used to find artifacts that still need to be mirrored. */
  public async listByStore(prefix: string): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    await Promise.all(
      this.stores.map(async (store) => {
        try {
          result.set(store.id, new Set(await store.list(prefix)));
        } catch {
          // an unreachable tier is simply skipped; it will be retried on the next pass
        }
      }),
    );
    return result;
  }

  public async delete(key: string): Promise<void> {
    await Promise.allSettled(this.stores.map((store) => store.delete(key)));
  }
}
