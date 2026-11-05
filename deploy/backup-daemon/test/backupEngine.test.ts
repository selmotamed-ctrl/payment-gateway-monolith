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
import { ENCRYPTION_KEY_HEX, PG_PASSWORD, RecordingRunner, S3_ACCESS_KEY, S3_SECRET_KEY, makeConfig } from "./helpers";

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

  test("WAL-G refuses audit backups without a dedicated audit data directory", async () => {
    const runner = new RecordingRunner();
    const engine = new WalGEngine(makeConfig(), runner);
    await expect(engine.triggerBackup("audit_db", "full")).rejects.toThrow("PG_AUDIT_DATA_DIR");
    expect(runner.calls).toHaveLength(0);
  });

  test("WAL-G prunes full backups for each target and leaves delta pruning non-destructive", async () => {
    const config = makeConfig();
    const runner = new RecordingRunner();
    const engine = new WalGEngine(config, runner);
    await engine.prune("all", "full");
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["delete", "retain", "FULL", "8", "--confirm"],
      ["delete", "retain", "FULL", "8", "--confirm"],
    ]);
    expect(runner.calls.map((call) => call.options?.env?.WALG_S3_PREFIX)).toEqual([
      "s3://libya-pg-backups-primary/prod/postgres_core",
      "s3://libya-pg-backups-primary/prod/audit_db",
    ]);

    runner.calls.length = 0;
    await engine.prune("postgres_core", "delta");
    expect(runner.calls).toHaveLength(0);
  });

  test("Barman handles core and audit separately with their own server names", async () => {
    const config = makeConfig({
      BACKUP_ENGINE_MODE: "barman",
      PG_PRIMARY_HOST: "db.internal",
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
