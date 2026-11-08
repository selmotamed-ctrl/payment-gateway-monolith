import { afterAll, describe, expect, test } from "bun:test";
import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import { ArtifactRepository, LocalRepoStore, MemoryArtifactStore } from "../src/artifactStore";
import { BackupEngineError, createBackupEngine, WalGEngine } from "../src/backupEngine";
import { masterKeyFromHex, signManifest, type BackupManifest } from "../src/cryptoEnvelope";
import { PgNativeEngine, buildRestoreCommand, parseWalRanges, streamHealthTarget, unexpectedBackupFiles } from "../src/pgNativeEngine";
import { walSegmentName } from "../src/walNames";
import { ENCRYPTION_KEY_HEX, RecordingRunner, makeConfig, tempDir } from "./helpers";

const master = masterKeyFromHex(ENCRYPTION_KEY_HEX);
const DAY = 86_400_000;
const NOW = new Date("2026-11-06T12:00:00.000Z");
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await nodeFs.rm(dir, { recursive: true, force: true });
});

const manifest = (input: { id: string; kind: "full" | "delta"; daysAgo: number; parent?: string; startSegment?: number; target?: string }): BackupManifest =>
  signManifest(
    {
      schemaVersion: 2,
      backupId: input.id,
      target: input.target ?? "postgres_core",
      kind: input.kind,
      engine: "pg-native",
      clusterTopology: "shared-audit",
      startedAt: new Date(NOW.getTime() - input.daysAgo * DAY - 60_000).toISOString(),
      completedAt: new Date(NOW.getTime() - input.daysAgo * DAY).toISOString(),
      startLsn: "0/1000028",
      endLsn: "0/1000100",
      ...(input.startSegment !== undefined ? { walSegmentStart: walSegmentName(1, input.startSegment) } : {}),
      ...(input.parent ? { parentBackupId: input.parent } : {}),
      uncompressedBytes: 1000,
      compressedBytes: 400,
      sha256Plaintext: "a".repeat(64),
      sha256Ciphertext: "b".repeat(64),
      encryption: { algorithm: "AES-256-GCM", kdf: "HKDF-SHA256", saltHex: "00", ivHex: "11", authTagHex: "22" },
      artifacts: input.kind === "full" ? { [`logical/payment_gateway_prod/${input.id}.dump.enc`]: { sha256Ciphertext: "c".repeat(64), bytes: 10 } } : undefined,
      storageTargets: ["primary-s3"],
    },
    master,
  );

const seed = async (store: MemoryArtifactStore, manifests: BackupManifest[], walSegments: number[] = []) => {
  for (const entry of manifests) {
    await store.putBuffer(`backups/${entry.target}/${entry.backupId}.manifest.json`, Buffer.from(JSON.stringify(entry)));
    await store.putBuffer(`backups/${entry.target}/${entry.backupId}.tar.zst.enc`, Buffer.from("artifact"));
    for (const key of Object.keys(entry.artifacts ?? {})) await store.putBuffer(key, Buffer.from("dump"));
  }
  for (const segment of walSegments) await store.putBuffer(`wal/postgres_core/${walSegmentName(1, segment)}.zst.enc`, Buffer.from("wal"));
  await store.putBuffer("wal/postgres_core/00000002.history.zst.enc", Buffer.from("history"));
};

const engineFor = async (store: MemoryArtifactStore, policy: { fullRetentionDays: number; walRetentionDays: number }, extra: Record<string, string> = {}) => {
  const state = await tempDir("bd-eng-");
  dirs.push(state);
  const config = makeConfig({ BACKUP_ENGINE_MODE: "pg-native", BACKUP_CATALOG_PATH: join(state, "catalog.json"), BACKUP_STAGING_DIR: join(state, "staging"), BACKUP_PRIMARY_S3_ENDPOINT: "", BACKUP_PRIMARY_S3_BUCKET: "", BACKUP_LOCAL_REPO_DIR: join(state, "repo"), ...extra });
  const runner = new RecordingRunner();
  const engine = new PgNativeEngine(config, runner, { repository: new ArtifactRepository([store]), getPolicy: () => policy, clock: () => NOW });
  return { engine, runner, config };
};

describe("createBackupEngine", () => {
  test("selects the engine from BACKUP_ENGINE_MODE", () => {
    const runner = new RecordingRunner();
    expect(createBackupEngine(makeConfig({ BACKUP_ENGINE_MODE: "wal-g" }), runner)).toBeInstanceOf(WalGEngine);
    const native = makeConfig({ BACKUP_ENGINE_MODE: "pg-native", BACKUP_LOCAL_REPO_DIR: "/tmp/never-created-by-constructor" });
    expect(createBackupEngine(native, runner, { repository: new ArtifactRepository([new MemoryArtifactStore("local-repo")]) })).toBeInstanceOf(PgNativeEngine);
  });
});

describe("manifest history and chain resolution", () => {
  test("lists only manifests whose signature verifies; a tampered one is ignored", async () => {
    const store = new MemoryArtifactStore("local-repo");
    const good = manifest({ id: "bkp_good_full", kind: "full", daysAgo: 3 });
    const forged = { ...manifest({ id: "bkp_forged_full", kind: "full", daysAgo: 1 }), compressedBytes: 1 };
    await seed(store, [good, forged]);
    const { engine } = await engineFor(store, { fullRetentionDays: 56, walRetentionDays: 14 });
    expect((await engine.listManifests("postgres_core")).map((entry) => entry.backupId)).toEqual(["bkp_good_full"]);
  });

  test("resolves the newest backup finished before the target time together with its chain back to the full backup", async () => {
    const store = new MemoryArtifactStore("local-repo");
    await seed(store, [
      manifest({ id: "f1", kind: "full", daysAgo: 10 }),
      manifest({ id: "d1", kind: "delta", daysAgo: 9, parent: "f1" }),
      manifest({ id: "d2", kind: "delta", daysAgo: 8, parent: "d1" }),
      manifest({ id: "f2", kind: "full", daysAgo: 3 }),
    ]);
    const { engine } = await engineFor(store, { fullRetentionDays: 56, walRetentionDays: 14 });
    const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);
    expect((await engine.resolveChain("postgres_core", at(8.5))).map((entry) => entry.backupId)).toEqual(["f1", "d1"]);
    expect((await engine.resolveChain("postgres_core", at(7))).map((entry) => entry.backupId)).toEqual(["f1", "d1", "d2"]);
    expect((await engine.resolveChain("postgres_core", at(0))).map((entry) => entry.backupId)).toEqual(["f2"]);
  });

  test("fails clearly when nothing completed before the target, or when a parent is missing", async () => {
    const store = new MemoryArtifactStore("local-repo");
    await seed(store, [manifest({ id: "f1", kind: "full", daysAgo: 1 }), manifest({ id: "orphan", kind: "delta", daysAgo: 0.5, parent: "gone" })]);
    const { engine } = await engineFor(store, { fullRetentionDays: 56, walRetentionDays: 14 });
    await expect(engine.resolveChain("postgres_core", new Date(NOW.getTime() - 5 * DAY))).rejects.toThrow("no postgres_core backup completed before");
    await expect(engine.resolveChain("postgres_core", NOW)).rejects.toThrow("depends on gone");
    const empty = await engineFor(new MemoryArtifactStore("local-repo"), { fullRetentionDays: 1, walRetentionDays: 1 });
    await expect(empty.engine.resolveChain("postgres_core", NOW)).rejects.toThrow("no verified postgres_core backup exists");
  });

  test("reconstructRuns rebuilds run history from signed manifests (replacement host without a catalog)", async () => {
    const store = new MemoryArtifactStore("local-repo");
    await seed(store, [manifest({ id: "f1", kind: "full", daysAgo: 4 }), manifest({ id: "d1", kind: "delta", daysAgo: 2, parent: "f1" })]);
    const { engine } = await engineFor(store, { fullRetentionDays: 56, walRetentionDays: 14 });
    const runs = await engine.reconstructRuns();
    expect(runs.map((run) => [run.id, run.kind, run.status, run.engine])).toEqual([["d1", "delta", "PASSED", "pg-native"], ["f1", "full", "PASSED", "pg-native"]]);
  });
});

describe("retention pruning follows the live policy", () => {
  const chains = () => [
    manifest({ id: "f1", kind: "full", daysAgo: 100, startSegment: 10 }),
    manifest({ id: "d1", kind: "delta", daysAgo: 99, parent: "f1" }),
    manifest({ id: "f2", kind: "full", daysAgo: 30, startSegment: 50 }),
    manifest({ id: "d2", kind: "delta", daysAgo: 29, parent: "f2" }),
    manifest({ id: "f3", kind: "full", daysAgo: 2, startSegment: 90 }),
  ];
  const ids = async (store: MemoryArtifactStore) =>
    [...store.objects.keys()].filter((key) => key.endsWith(".manifest.json")).map((key) => key.split("/").at(-1)!.replace(".manifest.json", "")).sort();

  test("drops whole chains older than fullRetentionDays, with their artifacts and logical dumps, and keeps the rest", async () => {
    const store = new MemoryArtifactStore("local-repo");
    await seed(store, chains(), [5, 10, 49, 50, 60, 95]);
    const { engine } = await engineFor(store, { fullRetentionDays: 56, walRetentionDays: 14 });
    await engine.prune("postgres_core", "full");
    expect(await ids(store)).toEqual(["d2", "f2", "f3"]); // f1 + its delta d1 are gone together
    expect(store.objects.has("backups/postgres_core/f1.tar.zst.enc")).toBe(false);
    expect(store.objects.has("backups/postgres_core/d1.tar.zst.enc")).toBe(false);
    expect(store.objects.has("logical/payment_gateway_prod/f1.dump.enc")).toBe(false);
    expect(store.objects.has("logical/payment_gateway_prod/f2.dump.enc")).toBe(true);
  });

  test("WAL older than the oldest RETAINED backup's start segment is deleted; newer WAL and timeline history are kept", async () => {
    const store = new MemoryArtifactStore("local-repo");
    await seed(store, chains(), [5, 10, 49, 50, 60, 95]);
    const { engine } = await engineFor(store, { fullRetentionDays: 56, walRetentionDays: 14 });
    await engine.prune("postgres_core", "full");
    const wal = [...store.objects.keys()].filter((key) => key.startsWith("wal/")).sort();
    expect(wal).toEqual(
      [
        "wal/postgres_core/00000002.history.zst.enc",
        `wal/postgres_core/${walSegmentName(1, 50)}.zst.enc`,
        `wal/postgres_core/${walSegmentName(1, 60)}.zst.enc`,
        `wal/postgres_core/${walSegmentName(1, 95)}.zst.enc`,
      ].sort(),
    );
  });

  test("a policy edited to 1 day still never deletes the newest full backup (or its deltas)", async () => {
    const store = new MemoryArtifactStore("local-repo");
    await seed(store, [...chains(), manifest({ id: "d3", kind: "delta", daysAgo: 1, parent: "f3" })]);
    const { engine } = await engineFor(store, { fullRetentionDays: 1, walRetentionDays: 1 });
    await engine.prune("postgres_core", "full");
    expect(await ids(store)).toEqual(["d3", "f3"]);
  });

  test("does nothing without a full backup, and delta pruning is non-destructive", async () => {
    const store = new MemoryArtifactStore("local-repo");
    await seed(store, [manifest({ id: "orphan-delta", kind: "delta", daysAgo: 200, parent: "gone" })]);
    const { engine } = await engineFor(store, { fullRetentionDays: 1, walRetentionDays: 1 });
    await engine.prune("postgres_core", "full");
    await engine.prune("postgres_core", "delta");
    expect(await ids(store)).toEqual(["orphan-delta"]);
  });

  test("a tampered manifest is never trusted to delete anything", async () => {
    const store = new MemoryArtifactStore("local-repo");
    const forged = { ...manifest({ id: "forged", kind: "full", daysAgo: 400, startSegment: 99999 }), kind: "delta" as const };
    await seed(store, [manifest({ id: "f3", kind: "full", daysAgo: 2, startSegment: 90 }), forged], [1, 2]);
    const { engine } = await engineFor(store, { fullRetentionDays: 56, walRetentionDays: 14 });
    await engine.prune("postgres_core", "full");
    expect(store.objects.has("backups/postgres_core/forged.manifest.json")).toBe(true); // untouched (ignored, not deleted)
  });

  test("the local WAL age window protects recent segments even when they are older than every retained backup", async () => {
    const state = await tempDir("bd-age-");
    dirs.push(state);
    const local = new LocalRepoStore(join(state, "repo"));
    // Seed through the real local store so files have real mtimes.
    await local.putBuffer(`backups/postgres_core/f3.manifest.json`, Buffer.from(JSON.stringify(manifest({ id: "f3", kind: "full", daysAgo: 2, startSegment: 90 }))));
    await local.putBuffer(`backups/postgres_core/f3.tar.zst.enc`, Buffer.from("a"));
    const oldSeg = `wal/postgres_core/${walSegmentName(1, 5)}.zst.enc`;
    const freshSeg = `wal/postgres_core/${walSegmentName(1, 6)}.zst.enc`;
    await local.putBuffer(oldSeg, Buffer.from("old"));
    await local.putBuffer(freshSeg, Buffer.from("fresh"));
    const longAgo = new Date(NOW.getTime() - 30 * DAY);
    await nodeFs.utimes(local.pathFor(oldSeg), longAgo, longAgo);
    // "Now" for the engine is one day after the fresh segment was written: well inside the 14-day window.
    const engineNow = new Date(NOW.getTime() + DAY);
    await nodeFs.utimes(local.pathFor(freshSeg), NOW, NOW);
    const config = makeConfig({ BACKUP_ENGINE_MODE: "pg-native", BACKUP_CATALOG_PATH: join(state, "catalog.json"), BACKUP_STAGING_DIR: join(state, "staging"), BACKUP_LOCAL_REPO_DIR: join(state, "repo"), BACKUP_PRIMARY_S3_ENDPOINT: "", BACKUP_PRIMARY_S3_BUCKET: "" });
    const engine = new PgNativeEngine(config, new RecordingRunner(), { repository: new ArtifactRepository([local]), getPolicy: () => ({ fullRetentionDays: 56, walRetentionDays: 14 }), clock: () => engineNow });
    await engine.prune("postgres_core", "full");
    expect(await local.exists(oldSeg)).toBe(false);
    expect(await local.exists(freshSeg)).toBe(true);
  });
});

describe("WAL stream health reports how far behind it is (found by the two-host lab)", () => {
  const status = { target: "postgres_core", running: true, startedAt: "2026-11-06T02:00:00.000Z", lastError: null };
  const MiB = 1024 * 1024;

  test("running and close behind the primary is healthy; the lag is shown", () => {
    const target = streamHealthTarget(status, 3 * MiB, 256 * MiB);
    expect(target).toMatchObject({ id: "wal-stream-postgres_core", healthy: true });
    expect(target.detail).toContain("3.0 MiB behind the primary");
  });

  test("a stream that is RUNNING but a gigabyte behind is NOT healthy (it is not protecting the data)", () => {
    const target = streamHealthTarget(status, 1100 * MiB, 256 * MiB);
    expect(target.healthy).toBe(false);
    expect(target.detail).toContain("1100.0 MiB behind");
    expect(target.detail).toContain("alert above 256 MiB");
    expect(streamHealthTarget(status, 256 * MiB, 256 * MiB).healthy).toBe(true); // at the threshold
  });

  test("unknown lag does not fail health on its own; a stream that is not running always does", () => {
    expect(streamHealthTarget(status, null, 256 * MiB)).toMatchObject({ healthy: true });
    expect(streamHealthTarget(status, null, 256 * MiB).detail).toContain("lag unknown");
    const down = streamHealthTarget({ ...status, running: false, lastError: "connection refused" }, 0, 256 * MiB);
    expect(down).toMatchObject({ healthy: false, detail: "connection refused" });
  });
});

describe("manifest times come from the primary's clock", () => {
  test("a backup host whose clock is hours off still stamps manifests with the primary's time; an unreachable primary falls back to the local clock", async () => {
    const store = new MemoryArtifactStore("local-repo");
    const { config } = await engineFor(store, { fullRetentionDays: 56, walRetentionDays: 14 });
    const runner = new RecordingRunner((command, args) =>
      (args.at(-1) ?? "").includes("clock_timestamp") ? { code: 0, stdout: "2031-05-06T07:08:09.123Z\n", stderr: "" } : { code: 0, stdout: "", stderr: "" });
    const skewed = new PgNativeEngine(config, runner, { repository: new ArtifactRepository([store]), clock: () => NOW });
    expect((await skewed.primaryClock("core")).toISOString()).toBe("2031-05-06T07:08:09.123Z");

    const down = new PgNativeEngine(config, new RecordingRunner(() => ({ code: 2, stdout: "", stderr: "connection refused" })), { repository: new ArtifactRepository([store]), clock: () => NOW });
    expect((await down.primaryClock("core")).toISOString()).toBe(NOW.toISOString());
    const garbage = new PgNativeEngine(config, new RecordingRunner(() => ({ code: 0, stdout: "not a date", stderr: "" })), { repository: new ArtifactRepository([store]), clock: () => NOW });
    expect((await garbage.primaryClock("core")).toISOString()).toBe(NOW.toISOString());
  });
});

describe("delta backup preconditions and restore command", () => {
  test("a delta fails loudly (never silently becomes a full) when summarize_wal is off or there is no full backup", async () => {
    const store = new MemoryArtifactStore("local-repo");
    const off = await engineFor(store, { fullRetentionDays: 56, walRetentionDays: 14 });
    // psql SHOW summarize_wal returns "off"
    const runnerOff = new RecordingRunner((command, args) => ((args.at(-1) ?? "").includes("summarize_wal") ? { code: 0, stdout: "off\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }));
    const engineOff = new PgNativeEngine(off.config, runnerOff, { repository: new ArtifactRepository([store]) });
    await expect(engineOff.triggerBackup("postgres_core", "delta")).rejects.toThrow("summarize_wal = on");
    expect(runnerOff.calls.some((call) => call.command.endsWith("pg_basebackup"))).toBe(false);

    const runnerOn = new RecordingRunner((command, args) => ((args.at(-1) ?? "").includes("summarize_wal") ? { code: 0, stdout: "on\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }));
    const engineOn = new PgNativeEngine(off.config, runnerOn, { repository: new ArtifactRepository([store]) });
    const failure = engineOn.triggerBackup("postgres_core", "delta");
    await expect(failure).rejects.toBeInstanceOf(BackupEngineError);
    await expect(failure).rejects.toThrow("needs a previous full backup");
    expect(runnerOn.calls.some((call) => call.command.endsWith("pg_basebackup"))).toBe(false);
  });

  test("a cluster with extra tablespaces is refused BEFORE any backup is produced", async () => {
    const store = new MemoryArtifactStore("local-repo");
    const { config } = await engineFor(store, { fullRetentionDays: 56, walRetentionDays: 14 });
    const runner = new RecordingRunner((command, args) => ((args.at(-1) ?? "").includes("pg_tablespace") ? { code: 0, stdout: "2\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }));
    const engine = new PgNativeEngine(config, runner, { repository: new ArtifactRepository([store]) });
    const failure = engine.triggerBackup("postgres_core", "full");
    await expect(failure).rejects.toBeInstanceOf(BackupEngineError);
    await expect(failure).rejects.toThrow("2 non-default tablespace");
    expect(runner.calls.some((call) => call.command.endsWith("pg_basebackup"))).toBe(false);
    expect(store.objects.size).toBe(0);
  });

  test("any file other than base.tar / pg_wal.tar / backup_manifest in a produced backup is an extra tablespace", () => {
    expect(unexpectedBackupFiles(["base.tar", "pg_wal.tar", "backup_manifest"])).toEqual([]);
    expect(unexpectedBackupFiles(["base.tar", "16385.tar", "pg_wal.tar", "backup_manifest"])).toEqual(["16385.tar"]);
  });

  test("the restore_command decrypts via the daemon helper with quoting that survives postgresql.conf", () => {
    const command = buildRestoreCommand("postgres_core", "/usr/local/bin/bun", "/opt/pg-backup-daemon/src/walFetchCli.ts");
    expect(command).toBe("''/usr/local/bin/bun'' ''/opt/pg-backup-daemon/src/walFetchCli.ts'' postgres_core %f %p");
    // A path with a space or quote cannot break out of the conf string literal.
    const hostile = buildRestoreCommand("audit_db", "/opt/it's here/bun", "/x/y.ts");
    expect(hostile).not.toMatch(/[^']'[^']/);
    expect(hostile).toContain("audit_db %f %p");
  });

  test("parses the LSN ranges from a real backup_manifest", () => {
    expect(parseWalRanges(JSON.stringify({ "WAL-Ranges": [{ Timeline: 1, "Start-LSN": "0/2000028", "End-LSN": "0/2000120" }, { Timeline: 2, "Start-LSN": "0/3000028", "End-LSN": "0/30000F0" }] }))).toEqual([
      { timeline: 1, startLsn: "0/2000028", endLsn: "0/2000120" },
      { timeline: 2, startLsn: "0/3000028", endLsn: "0/30000F0" },
    ]);
    expect(parseWalRanges("{}")).toEqual([]);
  });
});
