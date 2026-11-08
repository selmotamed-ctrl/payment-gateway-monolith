import { afterAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ArtifactRepository, LocalRepoStore, MemoryArtifactStore } from "../src/artifactStore";
import { masterKeyFromHex, openToBuffer } from "../src/cryptoEnvelope";
import { WalArchive, WalIngestError, WalMirror, WalStreamer, walKey } from "../src/walArchive";
import {
  archiveLagBytes,
  isArchivableWalFile,
  lsnToSegmentName,
  parseWalArchiveStatus,
  walSegmentName,
  walSegmentNumber,
} from "../src/walNames";
import { ENCRYPTION_KEY_HEX, RecordingRunner, makeConfig, tempDir } from "./helpers";

const master = masterKeyFromHex(ENCRYPTION_KEY_HEX);
const SEG1 = "000000010000000000000001";
const SEG2 = "000000010000000000000002";
const dirs: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await tempDir("bd-wal-");
  dirs.push(dir);
  return dir;
};
afterAll(async () => {
  for (const dir of dirs) await nodeFs.rm(dir, { recursive: true, force: true });
});

describe("WAL file names and archiver arithmetic", () => {
  test("recognises exactly what archive_command may push", () => {
    for (const ok of [SEG1, "00000001000000000000001A", "00000002.history", "000000010000000000000003.00000028.backup"]) {
      expect(isArchivableWalFile(ok)).toBe(true);
    }
    for (const bad of ["", "000000010000000000000001.partial", "00000001000000000000001a", "../000000010000000000000001", "0000000100000000000000011", "pg_control", "00000002.history.bak"]) {
      expect(isArchivableWalFile(bad)).toBe(false);
    }
  });

  test("segment numbers ignore the timeline and roll over the 256-segment log boundary", () => {
    expect(walSegmentNumber("0000000100000000000000FF")).toBe(255);
    expect(walSegmentNumber("000000010000000100000000")).toBe(256);
    expect(walSegmentNumber("000000020000000100000000")).toBe(256);
    expect(walSegmentNumber("not-a-segment")).toBeNull();
    expect(walSegmentName(1, 256)).toBe("000000010000000100000000");
    expect(walSegmentName(3, 255)).toBe("0000000300000000000000FF");
  });

  test("LSN to segment file name", () => {
    expect(lsnToSegmentName("0/2000028", 1)).toBe("000000010000000000000002");
    expect(lsnToSegmentName("1/0", 1)).toBe("000000010000000100000000");
    expect(lsnToSegmentName("0/18000028", 2)).toBe("000000020000000000000018");
    expect(lsnToSegmentName("garbage", 1)).toBeNull();
  });

  test("archive lag is computed from segment numbers, never from a text/lsn cast (RC-08)", () => {
    expect(archiveLagBytes("00000001000000000000001F", "00000001000000000000001A")).toBe(5 * 16 * 1024 * 1024);
    expect(archiveLagBytes("000000010000000100000002", "0000000100000000000000FE")).toBe(4 * 16 * 1024 * 1024);
    expect(archiveLagBytes("00000001000000000000000A", "00000001000000000000000A")).toBe(0);
    expect(archiveLagBytes("00000001000000000000000A", "")).toBe(0); // initial state
    expect(archiveLagBytes("00000001000000000000000A", "00000002.history")).toBe(0); // a history file was archived last
  });

  test("parses the pipe-separated status row, including the never-archived state", () => {
    expect(parseWalArchiveStatus("00000001000000000000001A|42|27|3|0/1F000028|00000001000000000000001F|false\n")).toEqual({
      lastArchivedWal: "00000001000000000000001A",
      lagSeconds: 42, // four completed segments are waiting, so the time counts
      secondsSinceLastArchive: 42,
      archivedCount: 27,
      failedCount: 3,
      currentLsn: "0/1F000028",
      currentWalFile: "00000001000000000000001F",
      lagBytes: 5 * 16 * 1024 * 1024,
      completedPendingSegments: 4,
      failing: false,
    });
    expect(parseWalArchiveStatus("|0|0|0|0/1000028|000000010000000000000001")).toMatchObject({ lastArchivedWal: "", lagSeconds: 0, lagBytes: 0, failing: false });
    expect(parseWalArchiveStatus("")).toMatchObject({ lastArchivedWal: "", lagSeconds: 0 });
    expect(parseWalArchiveStatus("x|not-a-number|||")).toMatchObject({ lagSeconds: 0 });
  });

  test("an IDLE database does not alarm: hours since the last archive count for nothing while no completed segment waits", () => {
    // current segment is the one right after the last archived one: it is being written, not late
    const idle = parseWalArchiveStatus("00000001000000000000001A|36000|27|0|0/1B000028|00000001000000000000001B|false");
    expect(idle).toMatchObject({ lagSeconds: 0, secondsSinceLastArchive: 36000, completedPendingSegments: 0, failing: false });
    // same segment as the last archived one (right after a switch) is equally fine
    expect(parseWalArchiveStatus("00000001000000000000001A|36000|27|0|0/1A000100|00000001000000000000001A|false").lagSeconds).toBe(0);
  });

  test("lag counts when a completed segment is waiting, and when the archiver is failing even if nothing completed yet", () => {
    expect(parseWalArchiveStatus("00000001000000000000001A|300|27|0|0/1C000028|00000001000000000000001C|false")).toMatchObject({ lagSeconds: 300, completedPendingSegments: 1 });
    expect(parseWalArchiveStatus("00000001000000000000001A|900|27|5|0/1B000028|00000001000000000000001B|true")).toMatchObject({ lagSeconds: 900, failing: true, completedPendingSegments: 0 });
    // archive never succeeded and is failing
    expect(parseWalArchiveStatus("|0|0|7|0/1000028|000000010000000000000001|true")).toMatchObject({ failing: true, failedCount: 7 });
  });
});

const makeArchive = async (extra: { remote?: MemoryArtifactStore; maxBytes?: string } = {}) => {
  const dir = await scratch();
  const config = makeConfig({
    BACKUP_ENGINE_MODE: "pg-native",
    BACKUP_STAGING_DIR: join(dir, "staging"),
    BACKUP_WAL_SPOOL_DIR: join(dir, "spool"),
    ...(extra.maxBytes ? { BACKUP_WAL_PUSH_MAX_BYTES: extra.maxBytes } : {}),
  });
  const local = new LocalRepoStore(join(dir, "repo"));
  const remote = extra.remote ?? new MemoryArtifactStore("primary-s3", "S3", "s3");
  const repository = new ArtifactRepository([local, remote]);
  const archive = new WalArchive({ config, repository, master, clock: () => new Date("2026-11-06T02:00:00.000Z") });
  return { dir, config, local, remote, repository, archive };
};

const body = (text: string | Buffer): Readable => Readable.from([Buffer.from(text)]);

describe("WalArchive ingest (PUT /v1/wal)", () => {
  test("stores the segment compressed + encrypted on the primary tier and tracks the last archived WAL", async () => {
    const { local, archive } = await makeArchive();
    const wal = Buffer.concat([Buffer.alloc(1024 * 1024, 0), Buffer.from("WAL-RECORD-MARKER")]);
    const result = await archive.ingestStream("postgres_core", SEG1, body(wal), wal.length);
    expect(result).toMatchObject({ status: "stored", key: `wal/postgres_core/${SEG1}.zst.enc` });

    const stored = (await local.getBuffer(walKey("postgres_core", SEG1)))!;
    expect(stored.includes(Buffer.from("WAL-RECORD-MARKER"))).toBe(false);
    expect(stored.length).toBeLessThan(wal.length / 10); // zeros compress away

    const sealed = join(await scratch(), "s.enc");
    await nodeFs.writeFile(sealed, stored);
    expect((await openToBuffer(sealed, { master, target: "wal:postgres_core", id: `wal/${SEG1}` })).equals(wal)).toBe(true);
    expect(archive.state()).toMatchObject({ lastArchivedWal: SEG1, received: 1, lastArchivedAt: "2026-11-06T02:00:00.000Z" });
  });

  test("is idempotent: the same bytes again are acknowledged as a duplicate", async () => {
    const { archive } = await makeArchive();
    await archive.ingestStream("postgres_core", SEG1, body("same"), 4);
    const again = await archive.ingestStream("postgres_core", SEG1, body("same"), 4);
    expect(again.status).toBe("duplicate");
    expect(archive.state()).toMatchObject({ received: 1, duplicates: 1 });
  });

  test("never overwrites: different bytes for an archived name are refused with 409", async () => {
    const { local, archive } = await makeArchive();
    await archive.ingestStream("postgres_core", SEG1, body("original"), 8);
    const before = await local.getBuffer(walKey("postgres_core", SEG1));
    const conflict = archive.ingestStream("postgres_core", SEG1, body("CHANGED!"), 8);
    await expect(conflict).rejects.toBeInstanceOf(WalIngestError);
    await expect(conflict).rejects.toMatchObject({ status: 409, code: "wal_conflict" });
    expect((await local.getBuffer(walKey("postgres_core", SEG1)))!.equals(before!)).toBe(true);
    expect(archive.state().conflicts).toBe(1);
  });

  test("lastArchivedWal only advances on segments (history/backup-label files do not move it) and never goes backwards", async () => {
    const { archive } = await makeArchive();
    await archive.ingestStream("postgres_core", SEG2, body("two"), 3);
    await archive.ingestStream("postgres_core", "00000002.history", body("hist"), 4);
    await archive.ingestStream("postgres_core", SEG1, body("one"), 3);
    expect(archive.state().lastArchivedWal).toBe(SEG2);
  });

  test("validates target and file name before touching storage", async () => {
    const { local, archive } = await makeArchive();
    await expect(archive.ingestStream("redis", SEG1, body("x"), 1)).rejects.toMatchObject({ status: 400, code: "invalid_wal_target" });
    for (const file of ["../../etc/passwd", "000000010000000000000001.partial", "random.txt", ""]) {
      await expect(archive.ingestStream("postgres_core", file, body("x"), 1)).rejects.toMatchObject({ status: 400, code: "invalid_wal_file" });
    }
    expect(await local.list("")).toEqual([]);
  });

  test("enforces the size cap from Content-Length and while streaming", async () => {
    const { local, archive } = await makeArchive({ maxBytes: "1000" });
    await expect(archive.ingestStream("postgres_core", SEG1, body("x"), 5000)).rejects.toMatchObject({ status: 413 });
    // A client that lies about (or omits) Content-Length is stopped mid-stream.
    await expect(archive.ingestStream("postgres_core", SEG1, body(Buffer.alloc(4000)), null)).rejects.toMatchObject({ status: 413 });
    expect(await local.list("wal")).toEqual([]);
  });

  test("rejects empty and truncated uploads", async () => {
    const { archive, local } = await makeArchive();
    await expect(archive.ingestStream("postgres_core", SEG1, body(""), 0)).rejects.toMatchObject({ code: "empty_wal_file" });
    await expect(archive.ingestStream("postgres_core", SEG1, body("12345"), 10)).rejects.toMatchObject({ code: "truncated_upload" });
    expect(await local.list("wal")).toEqual([]);
  });

  test("an S3-only deployment (no local repository) still works", async () => {
    const dir = await scratch();
    const config = makeConfig({ BACKUP_ENGINE_MODE: "pg-native", BACKUP_STAGING_DIR: join(dir, "staging") });
    const s3 = new MemoryArtifactStore("primary-s3");
    const archive = new WalArchive({ config, repository: new ArtifactRepository([s3]), master });
    await archive.ingestStream("audit_db", SEG1, body("audit-wal"), 9);
    expect(await s3.exists(walKey("audit_db", SEG1))).toBe(true);
    expect((await nodeFs.readdir(join(dir, "staging"))).filter((name) => name.endsWith(".sealing"))).toEqual([]);
  });
});

describe("WalMirror (asynchronous copy to the other tiers)", () => {
  test("ack happens on the primary tier; the remote tier catches up, retries after an outage and reconciles", async () => {
    const remote = new MemoryArtifactStore("primary-s3", "S3", "s3");
    remote.failPuts = true;
    const { archive, local } = await makeArchive({ remote });

    await archive.ingestStream("postgres_core", SEG1, body("one"), 3);
    await archive.mirror.drainOnce();
    expect(await local.exists(walKey("postgres_core", SEG1))).toBe(true);
    expect(await remote.exists(walKey("postgres_core", SEG1))).toBe(false);
    expect(archive.mirror.pendingCount()).toBe(1);
    expect(archive.mirror.lastError).toContain("primary-s3");

    remote.failPuts = false;
    expect(await archive.mirror.drainOnce()).toEqual({ mirrored: 1, failed: 0 });
    expect(await remote.exists(walKey("postgres_core", SEG1))).toBe(true);
    expect(archive.mirror.pendingCount()).toBe(0);
  });

  test("reconcile finds WAL that exists locally but never reached a mirror (e.g. after a daemon restart)", async () => {
    const { archive, local, remote, repository, dir } = await makeArchive();
    await local.putBuffer(walKey("postgres_core", SEG2), Buffer.from("orphan"));
    const mirror = new WalMirror(repository, join(dir, "staging"));
    expect(await mirror.reconcile()).toBe(1);
    await mirror.drainOnce();
    expect(await remote.exists(walKey("postgres_core", SEG2))).toBe(true);
    expect(await mirror.reconcile()).toBe(0);
    expect(archive).toBeDefined();
  });
});

describe("WalStreamer (pg_receivewal supervisor)", () => {
  class FakeChild extends EventEmitter {
    public exitCode: number | null = null;
    public readonly stderr = new EventEmitter();
    public killed = false;
    public kill(): boolean {
      this.killed = true;
      this.exitCode = 0;
      this.emit("close", 0);
      return true;
    }
  }

  test("creates the slot, spawns pg_receivewal with --synchronous against that slot, and restarts it when it dies", async () => {
    const { archive, config, dir } = await makeArchive();
    const runner = new RecordingRunner();
    const children: FakeChild[] = [];
    const spawned: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const streamer = new WalStreamer({
      config,
      runner,
      archive,
      cluster: "core",
      target: "postgres_core",
      slot: "pg_backup_core",
      spoolDir: join(dir, "spool", "postgres_core"),
      sweepIntervalMs: 3_600_000,
      spawnFn: (command, args, env) => {
        spawned.push({ command, args, env });
        const child = new FakeChild();
        children.push(child);
        return child as never;
      },
    });
    await streamer.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const create = runner.calls.find((call) => call.args.includes("--create-slot"));
    expect(create?.args).toEqual(expect.arrayContaining(["--slot=pg_backup_core", "--if-not-exists"]));
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.command.endsWith("pg_receivewal")).toBe(true);
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(["--slot=pg_backup_core", "--synchronous", "-D", join(dir, "spool", "postgres_core")]));
    // Passwords only ever travel in the environment, never in argv.
    expect(spawned[0]!.args.join(" ")).not.toContain(config.PG_PRIMARY_PASSWORD);
    expect(streamer.getStatus().running).toBe(true);

    children[0]!.stderr.emit("data", Buffer.from("connection lost"));
    children[0]!.emit("close", 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(streamer.getStatus()).toMatchObject({ running: false, lastExitCode: 1 });
    expect(streamer.getStatus().lastError).toContain("connection lost");

    const started = Date.now();
    await streamer.stop();
    // stop() cuts the restart backoff short instead of waiting it out...
    expect(Date.now() - started).toBeLessThan(500);
    // ...and terminates a pg_receivewal that is running at that moment.
    expect(streamer.getStatus().running).toBe(false);
    expect(children.length === 1 || children.at(-1)!.killed).toBe(true);
  });

  test("sweeps completed segments into the repository, leaves the .partial file, and removes the spool copy", async () => {
    const { archive, config, dir, local } = await makeArchive();
    const spool = join(dir, "spool", "postgres_core");
    await nodeFs.mkdir(spool, { recursive: true });
    await nodeFs.writeFile(join(spool, SEG1), "complete-segment");
    await nodeFs.writeFile(join(spool, `${SEG2}.partial`), "still-being-written");
    await nodeFs.writeFile(join(spool, "00000002.history"), "timeline-2");
    const streamer = new WalStreamer({ config, runner: new RecordingRunner(), archive, cluster: "core", target: "postgres_core", slot: "s", spoolDir: spool });

    expect(await streamer.sweepOnce()).toBe(2);
    expect((await nodeFs.readdir(spool)).sort()).toEqual([`${SEG2}.partial`]);
    expect(await local.exists(walKey("postgres_core", SEG1))).toBe(true);
    expect(await local.exists(walKey("postgres_core", "00000002.history"))).toBe(true);
    expect(await streamer.sweepOnce()).toBe(0);
  });

  test("a segment that conflicts with the archive is quarantined, not deleted and not re-archived", async () => {
    const { archive, config, dir } = await makeArchive();
    await archive.ingestStream("postgres_core", SEG1, body("archived-version"), 16);
    const spool = join(dir, "spool", "postgres_core");
    await nodeFs.mkdir(spool, { recursive: true });
    await nodeFs.writeFile(join(spool, SEG1), "DIFFERENT-version");
    const streamer = new WalStreamer({ config, runner: new RecordingRunner(), archive, cluster: "core", target: "postgres_core", slot: "s", spoolDir: spool });
    await streamer.sweepOnce();
    expect(await nodeFs.readdir(join(spool, "conflicts"))).toEqual([SEG1]);
  });
});
