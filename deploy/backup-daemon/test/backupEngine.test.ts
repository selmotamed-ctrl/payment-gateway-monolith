import { describe, expect, test } from "bun:test";
import {
  WAL_ARCHIVE_STATUS_QUERY,
  WAL_LAG_QUERY,
  BarmanEngine,
  WalGEngine,
  barmanServerName,
  buildBarmanBackupCommand,
  buildBarmanCheckCommand,
  buildBarmanCloudBackupCommand,
  buildBarmanListBackupsCommand,
  buildBarmanRecoverCommand,
  buildWalGArchiveStatusCommand,
  buildWalGBaseBackupCommand,
  buildWalGBackupCommand,
  buildWalGDeltaBackupCommand,
  buildWalGLagQueryCommand,
  buildWalGListBackupsCommand,
  buildWalGMirrorCommand,
  buildWalGPruneCommand,
  buildWalGVerifyBucketCommand,
  parseBarmanBackupList,
  parseReplicaNodes,
  parseWalGBackupList,
} from "../src/backupEngine";
import { rmSync } from "node:fs";
import { ArtifactRepository, MemoryArtifactStore } from "../src/artifactStore";
import { expandTargets } from "../src/backupEngine";
import { ENCRYPTION_KEY_HEX, PG_PASSWORD, RecordingRunner, S3_ACCESS_KEY, S3_SECRET_KEY, dumpAwareRunner, makeConfig, tempDir } from "./helpers";

describe("WAL-G command builders", () => {
  const config = makeConfig({
    PG_DATA_DIR: "/var/lib/postgresql/18/main",
    BACKUP_SECONDARY_SSH_TARGET: "backup-vault@198.51.100.99:/mnt/offsite-vault/pg",
    PG_REPLICA_NODES: "replica-1@10.0.0.11:22:10.0.0.12:5433",
  });

  test("builds a full backup-push with compression and encryption environment", () => {
    const command = buildWalGBaseBackupCommand(config);
    expect(command.command).toBe("wal-g");
    expect(command.args).toEqual(["backup-push", "/var/lib/postgresql/18/main"]);
    expect(command.env).toMatchObject({
      WALG_S3_PREFIX: "s3://libya-pg-backups-primary/prod/postgres_core",
      AWS_ENDPOINT_URL: "https://s3.eu-central-1.amazonaws.com",
      AWS_ENDPOINT_URL_S3: "https://s3.eu-central-1.amazonaws.com",
      AWS_ACCESS_KEY_ID: S3_ACCESS_KEY,
      AWS_SECRET_ACCESS_KEY: S3_SECRET_KEY,
      WALG_COMPRESSION_METHOD: "zstd",
      WALG_LIBSODIUM_KEY: ENCRYPTION_KEY_HEX,
      PGPASSWORD: PG_PASSWORD,
    });
  });

  test("builds a delta backup-push with --delta and a JSON list command", () => {
    expect(buildWalGDeltaBackupCommand(config, "postgres_core").args).toEqual([
      "backup-push",
      "--delta",
      "/var/lib/postgresql/18/main",
    ]);
    expect(buildWalGListBackupsCommand(config).args).toEqual(["backup-list", "--json"]);
    expect(buildWalGBaseBackupCommand(config, "postgres_core").args).toEqual([
      "backup-push",
      "/var/lib/postgresql/18/main",
    ]);
    expect(buildWalGBackupCommand(config, "postgres_core", "delta").args).toContain("--delta");
  });

  test("uses the audit data directory and audit S3 prefix when configured", () => {
    const auditConfig = makeConfig({ PG_AUDIT_DATA_DIR: "/var/lib/postgresql/18/audit" });
    expect(buildWalGBaseBackupCommand(auditConfig, "audit_db")).toMatchObject({
      args: ["backup-push", "/var/lib/postgresql/18/audit"],
      env: { WALG_S3_PREFIX: "s3://libya-pg-backups-primary/prod/audit_db" },
    });
    expect(buildWalGListBackupsCommand(auditConfig, "audit_db").env?.WALG_S3_PREFIX).toBe(
      "s3://libya-pg-backups-primary/prod/audit_db",
    );
    expect(buildWalGVerifyBucketCommand(auditConfig, "audit_db").args).toEqual(["st", "ls"]);
    expect(buildWalGMirrorCommand({ ...auditConfig, BACKUP_SECONDARY_SSH_TARGET: "vault@host:/mnt/vault" }, "audit_db")?.args).toEqual([
      "copy",
      "s3://libya-pg-backups-primary/prod/audit_db",
      "vault@host:/mnt/vault",
    ]);
  });

  test("refuses an audit WAL-G target without PG_AUDIT_DATA_DIR instead of backing up core", () => {
    expect(() => buildWalGBaseBackupCommand(config, "audit_db")).toThrow("PG_AUDIT_DATA_DIR");
    expect(() => buildWalGDeltaBackupCommand(config, "audit_db")).toThrow("PG_AUDIT_DATA_DIR");
  });

  test("builds retention and target-aware prune commands", () => {
    expect(buildWalGPruneCommand(config, "postgres_core").args).toEqual([
      "delete",
      "retain",
      "FULL",
      "8",
      "--confirm",
    ]);
    expect(buildWalGPruneCommand(config, "audit_db").env?.WALG_S3_PREFIX).toBe(
      "s3://libya-pg-backups-primary/prod/audit_db",
    );
  });

  test("mirrors S3 archives with rclone and local archives with rsync", () => {
    expect(buildWalGMirrorCommand(config)).toMatchObject({
      command: "rclone",
      args: ["copy", "s3://libya-pg-backups-primary/prod/postgres_core", "backup-vault@198.51.100.99:/mnt/offsite-vault/pg"],
    });
    const localConfig = makeConfig({
      BACKUP_PRIMARY_S3_BUCKET: "/srv/pg-backups/",
      BACKUP_SECONDARY_SSH_TARGET: "vault@host:/mnt/vault/",
    });
    expect(buildWalGMirrorCommand(localConfig)).toMatchObject({
      command: "rsync",
      args: ["-a", "/srv/pg-backups/postgres_core/", "vault@host:/mnt/vault/"],
    });
    expect(buildWalGMirrorCommand(makeConfig())).toBeNull();
    expect(buildWalGMirrorCommand({ ...config, BACKUP_SECONDARY_MIRROR_DELETE: true })).toMatchObject({ command: "rclone", args: ["sync", expect.any(String), expect.any(String)] });
    expect(buildWalGMirrorCommand({ ...localConfig, BACKUP_SECONDARY_MIRROR_DELETE: true })?.args).toContain("--delete");
  });

  test("verifies the primary bucket through wal-g storage", () => {
    expect(buildWalGVerifyBucketCommand(config)).toMatchObject({
      command: "wal-g",
      args: ["st", "ls"],
    });
  });

  test("queries replica LSN lag and primary archive status through psql", () => {
    const lag = buildWalGLagQueryCommand(config);
    expect(lag.command).toBe("/usr/lib/postgresql/18/bin/psql");
    expect(lag.args).toContain("10.0.0.12");
    expect(lag.args).toContain("5433");
    expect(lag.args.at(-1)).toBe(WAL_LAG_QUERY);
    expect(lag.env).toEqual({ PGPASSWORD: PG_PASSWORD });

    const archive = buildWalGArchiveStatusCommand(config);
    expect(archive.args).toContain("127.0.0.1");
    expect(archive.args.at(-1)).toBe(WAL_ARCHIVE_STATUS_QUERY);
  });

  test("parses replica node lists and JSON backup listings", () => {
    expect(parseReplicaNodes("r1@10.0.0.11:22:10.0.0.12:5433,r2@10.0.0.21:22:10.0.0.22:5432")).toEqual([
      { id: "r1", host: "10.0.0.12", port: 5433 },
      { id: "r2", host: "10.0.0.22", port: 5432 },
    ]);
    expect(
      parseWalGBackupList(
        JSON.stringify([
          {
            backup_name: "base_0001",
            time: "2026-11-01T02:00:00Z",
            finish_time: "2026-11-01T02:10:00Z",
            size: 1234,
            start_lsn: "0/100",
            end_lsn: "0/200",
          },
        ]),
      ),
    ).toEqual([
      {
        backupId: "base_0001",
        startedAt: "2026-11-01T02:00:00.000Z",
        completedAt: "2026-11-01T02:10:00.000Z",
        sizeBytes: 1234,
        startLsn: "0/100",
        endLsn: "0/200",
      },
    ]);
  });
});

describe("Barman command builders", () => {
  const config = makeConfig({
    BACKUP_ENGINE_MODE: "barman",
    PG_PRIMARY_HOST: "db.internal",
    BARMAN_SERVER: "primary",
    BACKUP_PRIMARY_S3_BUCKET: "s3://audit-backups/prod",
  });

  test("builds check, full/delta backup and list commands", () => {
    expect(barmanServerName(config)).toBe("primary");
    expect(barmanServerName(config, "audit_db")).toBe("pg_audit_db");
    expect(barmanServerName({ ...config, BARMAN_AUDIT_SERVER: "audit-primary" }, "audit_db")).toBe("audit-primary");
    expect(buildBarmanCheckCommand(config).args).toEqual(["check", "primary"]);
    expect(buildBarmanCheckCommand(config, "audit_db").args).toEqual(["check", "pg_audit_db"]);
    expect(buildBarmanBackupCommand(config, "full", "audit_db").args).toEqual(["backup", "pg_audit_db"]);
    expect(buildBarmanListBackupsCommand(config, "audit_db").args).toEqual(["list-backup", "pg_audit_db"]);
    expect(buildBarmanBackupCommand(config, "full").args).toEqual(["backup", "primary"]);
    expect(buildBarmanBackupCommand(config, "delta").args).toEqual(["backup", "--incremental", "primary"]);
    expect(buildBarmanListBackupsCommand(config).args).toEqual(["list-backup", "primary"]);
  });

  test("builds PITR recover and barman-cloud-backup commands", () => {
    const targetTime = new Date("2026-11-03T09:55:00.000Z");
    expect(buildBarmanRecoverCommand(config, "20261103T020000", "/var/lib/pg-backup-scratch", targetTime)).toMatchObject({
      command: "barman",
      args: [
        "recover",
        "primary",
        "20261103T020000",
        "/var/lib/pg-backup-scratch",
        "--target-time",
        "2026-11-03T09:55:00.000Z",
      ],
    });
    const cloud = buildBarmanCloudBackupCommand(config);
    expect(cloud.command).toBe("barman-cloud-backup");
    expect(cloud.args).toEqual([
      "--cloud-provider",
      "aws-s3",
      "--endpoint-url",
      "https://s3.eu-central-1.amazonaws.com",
      "s3://audit-backups/prod",
      "primary",
    ]);
    expect(cloud.env?.WALG_COMPRESSION_METHOD).toBe("zstd");
  });

  test("parses barman list-backup output", () => {
    const rows = parseBarmanBackupList(
      "primary 20261101T020000 - Sun Nov  1 02:00:00 2026 - Size: 2048.0 MiB - WAL Size: 12.0 MiB\n" +
        "primary 20261102T020000 - Mon Nov  2 02:00:00 2026 - Size: 1024.0 MiB - WAL Size: 12.0 MiB\n",
    );
    expect(rows.map((row) => row.backupId)).toEqual(["20261101T020000", "20261102T020000"]);
    expect(rows[0]?.sizeBytes).toBe(2048);
  });

  test("builders are pure and do not execute commands", () => {
    const runner = new RecordingRunner();
    buildWalGBaseBackupCommand(makeConfig());
    buildWalGDeltaBackupCommand(makeConfig());
    buildWalGPruneCommand(makeConfig());
    buildWalGListBackupsCommand(makeConfig());
    buildWalGVerifyBucketCommand(makeConfig());
    buildWalGLagQueryCommand(makeConfig());
    buildBarmanCheckCommand(config);
    buildBarmanBackupCommand(config, "full");
    buildBarmanListBackupsCommand(config);
    buildBarmanRecoverCommand(config, "id", "/tmp/scratch", new Date(0));
    buildBarmanCloudBackupCommand(config);
    expect(runner.calls).toHaveLength(0);
  });
});

describe("target-aware engine routing", () => {
  test("WAL-G audit backups, lists and recoveries use the audit prefix and directory", async () => {
    const config = makeConfig({
      PG_AUDIT_DATA_DIR: "/var/lib/postgresql/18/audit",
    });
    const runner = new RecordingRunner();
    const engine = new WalGEngine(config, runner);

    await engine.triggerBackup("audit_db", "full");
    const push = runner.calls.find((call) => call.args[0] === "backup-push");
    expect(push?.args).toEqual(["backup-push", "/var/lib/postgresql/18/audit"]);
    expect(push?.options?.env?.WALG_S3_PREFIX).toBe("s3://libya-pg-backups-primary/prod/audit_db");
    const verify = runner.calls.find((call) => call.args[0] === "st");
    expect(verify?.args).toEqual(["st", "ls"]);

    runner.calls.length = 0;
    await engine.recover({
      target: "audit_db",
      targetTime: new Date("2026-11-03T09:55:00.000Z"),
      targetDir: "/var/lib/pg-backup/scratch/audit",
      port: 55433,
    });
    expect(runner.calls[0]?.args).toEqual([
      "backup-fetch",
      "/var/lib/pg-backup/scratch/audit",
      "LATEST",
    ]);
    expect(runner.calls[0]?.options?.env?.WALG_S3_PREFIX).toBe(
      "s3://libya-pg-backups-primary/prod/audit_db",
    );
  });

  test("WAL-G backs up a shared-cluster audit database logically and never needs PG_AUDIT_DATA_DIR (RC-09)", async () => {
    const staging = await tempDir();
    try {
      const config = makeConfig({ BACKUP_STAGING_DIR: staging, PG_AUDIT_USER: "gw_audit_writer", PG_AUDIT_PASSWORD: "audit-secret-pw" });
      const runner = dumpAwareRunner();
      const s3 = new MemoryArtifactStore("primary-s3");
      const engine = new WalGEngine(config, runner, { repository: new ArtifactRepository([s3]) });
      const result = await engine.triggerBackup("audit_db", "full");

      expect(result.storageTargets).toEqual(["primary-s3"]);
      // No wal-g invocation at all: the audit database is already inside the core physical backup.
      expect(runner.calls.some((call) => call.command === "wal-g")).toBe(false);
      const dump = runner.calls.find((call) => call.command.endsWith("pg_dump"));
      expect(dump?.args).toEqual(expect.arrayContaining(["--format=custom", "-d", config.PG_AUDIT_DB_NAME]));
      // the dump runs as the least-privilege audit role, with its password in the environment only
      expect(dump?.args[dump.args.indexOf("-U") + 1]).toBe("gw_audit_writer");
      expect(dump?.args.join(" ")).not.toContain("audit-secret-pw");
      expect(dump?.options?.env?.PGPASSWORD).toBe("audit-secret-pw");
      expect(runner.calls.some((call) => call.command.endsWith("pg_restore") && call.args.includes("--list"))).toBe(true);
      const keys = [...s3.objects.keys()];
      expect(keys.some((key) => key.startsWith(`logical/${config.PG_AUDIT_DB_NAME}/`) && key.endsWith(".dump.enc"))).toBe(true);
      expect(keys.some((key) => key.startsWith("backups/audit_db/") && key.endsWith(".manifest.json"))).toBe(true);
      // The dump is encrypted: the plaintext archive header must not be visible in storage.
      const dumpObject = s3.objects.get(keys.find((key) => key.endsWith(".dump.enc"))!)!;
      expect(dumpObject.includes(Buffer.from("PGDMP"))).toBe(false);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test("target=all with a shared audit database no longer throws and skips a missing audit database", async () => {
    const staging = await tempDir();
    try {
      const config = makeConfig({ BACKUP_STAGING_DIR: staging });
      const runner = dumpAwareRunner({ auditDatabasePresent: false });
      const engine = new WalGEngine(config, runner, { repository: new ArtifactRepository([new MemoryArtifactStore("primary-s3")]) });
      await expect(engine.triggerBackup("all", "full")).resolves.toMatchObject({ storageTargets: ["primary-s3"] });
      expect(runner.calls.filter((call) => call.command === "wal-g" && call.args[0] === "backup-push")).toHaveLength(1);
      // An explicit audit_db request must fail loudly instead of silently skipping.
      await expect(engine.triggerBackup("audit_db", "full")).rejects.toThrow("does not exist");
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test("expandTargets follows the topology: audit is always a target, redis only when configured", () => {
    expect(expandTargets(makeConfig(), "all")).toEqual(["postgres_core", "audit_db"]);
    expect(expandTargets(makeConfig({ REDIS_URL: "redis://127.0.0.1:6379" }), "all")).toEqual(["postgres_core", "audit_db", "redis"]);
    expect(expandTargets(makeConfig(), "redis")).toEqual(["redis"]);
  });

  test("WAL-G prunes the core target, and the audit target only for a dedicated cluster; delta pruning is non-destructive", async () => {
    const runner = new RecordingRunner();
    await new WalGEngine(makeConfig(), runner).prune("all", "full");
    expect(runner.calls.map((call) => call.args)).toEqual([["delete", "retain", "FULL", "8", "--confirm"]]);

    const dedicated = makeConfig({ PG_AUDIT_DATA_DIR: "/var/lib/postgresql/18/audit" });
    const dedicatedRunner = new RecordingRunner();
    await new WalGEngine(dedicated, dedicatedRunner).prune("all", "full");
    expect(dedicatedRunner.calls.map((call) => call.options?.env?.WALG_S3_PREFIX)).toEqual([
      "s3://libya-pg-backups-primary/prod/postgres_core",
      "s3://libya-pg-backups-primary/prod/audit_db",
    ]);

    dedicatedRunner.calls.length = 0;
    await new WalGEngine(dedicated, dedicatedRunner).prune("postgres_core", "delta");
    expect(dedicatedRunner.calls).toHaveLength(0);
  });

  test("WAL-G retention follows the live maker-checker policy, not the boot-time environment", async () => {
    const runner = new RecordingRunner();
    const engine = new WalGEngine(makeConfig(), runner, { getPolicy: () => ({ fullRetentionDays: 21, walRetentionDays: 7 }) });
    await engine.prune("postgres_core", "full");
    expect(runner.calls[0]?.args).toEqual(["delete", "retain", "FULL", "3", "--confirm"]);

    // A policy edited down to one day still keeps at least one full backup.
    const minimal = new RecordingRunner();
    await new WalGEngine(makeConfig(), minimal, { getPolicy: () => ({ fullRetentionDays: 1, walRetentionDays: 1 }) }).prune("postgres_core", "full");
    expect(minimal.calls[0]?.args).toEqual(["delete", "retain", "FULL", "1", "--confirm"]);
  });

  test("Barman handles core and audit separately with their own server names", async () => {
    const config = makeConfig({
      BACKUP_ENGINE_MODE: "barman",
      PG_PRIMARY_HOST: "db.internal",
      PG_AUDIT_DATA_DIR: "/var/lib/postgresql/18/audit",
      BARMAN_SERVER: "primary",
      BARMAN_AUDIT_SERVER: "audit-primary",
    });
    const runner = new RecordingRunner();
    const engine = new BarmanEngine(config, runner);
    await engine.triggerBackup("all", "full");
    expect(runner.calls.map((call) => call.args.slice(0, 2))).toEqual([
      ["check", "primary"],
      ["backup", "primary"],
      ["--cloud-provider", "aws-s3"],
      ["check", "audit-primary"],
      ["backup", "audit-primary"],
      ["--cloud-provider", "aws-s3"],
    ]);
    expect(runner.calls[2]?.args.at(-1)).toBe("primary");
    expect(runner.calls[5]?.args.at(-1)).toBe("audit-primary");

    runner.calls.length = 0;
    await engine.prune("all", "full");
    expect(runner.calls).toHaveLength(0);
  });

  test("Barman recovery uses the audit server", async () => {
    const config = makeConfig({
      BACKUP_ENGINE_MODE: "barman",
      BARMAN_SERVER: "primary",
      BARMAN_AUDIT_SERVER: "audit-primary",
    });
    const runner = new RecordingRunner();
    const engine = new BarmanEngine(config, runner);
    await engine.recover({
      target: "audit_db",
      targetTime: new Date("2026-11-03T09:55:00.000Z"),
      targetDir: "/var/lib/pg-backup/scratch/audit",
      port: 55433,
    });
    expect(runner.calls[0]?.args).toEqual(["list-backup", "audit-primary"]);
    const recover = runner.calls.find((call) => call.args[0] === "recover");
    expect(recover?.args).toEqual([
      "recover",
      "audit-primary",
      "latest",
      "/var/lib/pg-backup/scratch/audit",
      "--target-time",
      "2026-11-03T09:55:00.000Z",
    ]);
  });
});

describe("recover to latest (disaster recovery)", () => {
  const request = { target: "postgres_core" as const, targetTime: new Date("2026-11-03T09:55:00.000Z"), targetDir: "/var/lib/pg-backup/scratch", port: 55432 };

  test("WAL-G: a target-time recovery sets recovery_target_time, latest sets NONE so PostgreSQL replays until the archive ends", async () => {
    const engine = new WalGEngine(makeConfig(), new RecordingRunner());
    const timed = await engine.recover(request);
    expect(timed.recoveryConf).toContain("recovery_target_time = '2026-11-03 09:55:00.000+00'");
    expect(timed.recoveryConf).toContain("recovery_target_action = 'promote'");
    const latest = await engine.recover({ ...request, latest: true });
    expect(latest.recoveryConf).toContain("restore_command");
    expect(latest.recoveryConf).not.toContain("recovery_target");
  });

  test("Barman: latest omits --target-time", async () => {
    const config = makeConfig({ BACKUP_ENGINE_MODE: "barman", BARMAN_SERVER: "primary" });
    const runner = new RecordingRunner();
    await new BarmanEngine(config, runner).recover({ ...request, latest: true });
    const recover = runner.calls.find((call) => call.args[0] === "recover")!;
    expect(recover.args).not.toContain("--target-time");
    const timedRunner = new RecordingRunner();
    await new BarmanEngine(config, timedRunner).recover(request);
    expect(timedRunner.calls.find((call) => call.args[0] === "recover")!.args).toContain("--target-time");
  });
});

describe("Barman health (RC-06)", () => {
  test("never calls wal-g: object-store health comes from the daemon's own S3 client, audit server only when dedicated", async () => {
    const runner = new RecordingRunner();
    const s3 = new MemoryArtifactStore("primary-s3");
    const config = makeConfig({ BACKUP_ENGINE_MODE: "barman" });
    const health = await new BarmanEngine(config, runner, { repository: new ArtifactRepository([s3]) }).overviewHealth();

    expect(runner.calls.some((call) => call.command === "wal-g")).toBe(false);
    expect(health.targets.find((target) => target.id === "primary-s3")).toMatchObject({ healthy: true });
    expect(health.targets.some((target) => target.id === "barman-audit")).toBe(false);

    const dedicated = makeConfig({ BACKUP_ENGINE_MODE: "barman", PG_AUDIT_DATA_DIR: "/var/lib/postgresql/18/audit" });
    const dedicatedHealth = await new BarmanEngine(dedicated, new RecordingRunner(), { repository: new ArtifactRepository([s3]) }).overviewHealth();
    expect(dedicatedHealth.targets.some((target) => target.id === "barman-audit")).toBe(true);

    s3.failPuts = true;
    const down = await new BarmanEngine(config, new RecordingRunner(), { repository: new ArtifactRepository([s3]) }).overviewHealth();
    expect(down.targets.find((target) => target.id === "primary-s3")?.healthy).toBe(false);
    expect(down.healthy).toBe(false);
  });
});

describe("WAL archive status (RC-08)", () => {
  test("the query never passes the WAL file name to pg_wal_lsn_diff and returns six fields", () => {
    expect(WAL_ARCHIVE_STATUS_QUERY).not.toContain("pg_wal_lsn_diff");
    expect(WAL_ARCHIVE_STATUS_QUERY).toContain("pg_walfile_name(pg_current_wal_lsn())");
    expect(WAL_ARCHIVE_STATUS_QUERY).toContain("COALESCE(last_archived_wal, '')");
  });

  test("health parses a real 24-character segment name and computes lag bytes from segment numbers", async () => {
    const runner = new RecordingRunner((command, args) => {
      const query = args.at(-1) ?? "";
      if (query === WAL_ARCHIVE_STATUS_QUERY) {
        return { code: 0, stdout: "00000001000000000000001A|42|27|0|0/1F000028|00000001000000000000001F|false\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const health = await new WalGEngine(makeConfig(), runner).overviewHealth();
    expect(health.wal.archiveLagSeconds).toBe(42);
    expect(health.wal.lastArchivedLsn).toBe("00000001000000000000001A");
    // 0x1F - 0x1A = 5 segments of 16 MiB
    expect(health.wal.lagBytes).toBe(5 * 16 * 1024 * 1024);
    expect(health.wal.currentLsn).toBe("0/1F000028");
  });

  test("health on an idle database stays healthy however long ago the last archive was", async () => {
    const runner = new RecordingRunner((command, args) =>
      (args.at(-1) ?? "") === WAL_ARCHIVE_STATUS_QUERY
        ? { code: 0, stdout: "00000001000000000000001A|90000|27|0|0/1B000028|00000001000000000000001B|false\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const health = await new WalGEngine(makeConfig(), runner).overviewHealth();
    expect(health.wal.archiveLagSeconds).toBe(0);
    expect(health.healthy).toBe(true);
  });

  test("the initial empty archiver state (no segment archived yet) is valid and reports zero lag", async () => {
    const runner = new RecordingRunner((command, args) =>
      (args.at(-1) ?? "") === WAL_ARCHIVE_STATUS_QUERY
        ? { code: 0, stdout: "|0|0|0|0/1000028|000000010000000000000001|false\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const health = await new WalGEngine(makeConfig(), runner).overviewHealth();
    expect(health.wal.archiveLagSeconds).toBe(0);
    expect(health.wal.lagBytes).toBe(0);
  });
});
