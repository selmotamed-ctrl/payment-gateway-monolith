import { describe, expect, test } from "bun:test";
import {
  WAL_ARCHIVE_STATUS_QUERY,
  WAL_LAG_QUERY,
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
      WALG_S3_PREFIX: "s3://libya-pg-backups-primary/prod",
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
    expect(buildWalGDeltaBackupCommand(config, "audit_db").args).toEqual([
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

  test("uses the audit data directory when configured", () => {
    const auditConfig = makeConfig({ PG_AUDIT_DATA_DIR: "/var/lib/postgresql/18/audit" });
    expect(buildWalGBaseBackupCommand(auditConfig, "audit_db").args).toEqual([
      "backup-push",
      "/var/lib/postgresql/18/audit",
    ]);
  });

  test("mirrors S3 archives with rclone and local archives with rsync", () => {
    expect(buildWalGMirrorCommand(config)).toMatchObject({
      command: "rclone",
      args: ["sync", "s3://libya-pg-backups-primary/prod", "backup-vault@198.51.100.99:/mnt/offsite-vault/pg"],
    });
    const localConfig = makeConfig({
      BACKUP_PRIMARY_S3_BUCKET: "/srv/pg-backups/",
      BACKUP_SECONDARY_SSH_TARGET: "vault@host:/mnt/vault/",
    });
    expect(buildWalGMirrorCommand(localConfig)).toMatchObject({
      command: "rsync",
      args: ["-a", "--delete", "/srv/pg-backups/", "vault@host:/mnt/vault/"],
    });
    expect(buildWalGMirrorCommand(makeConfig())).toBeNull();
  });

  test("verifies the primary bucket through wal-g storage", () => {
    expect(buildWalGVerifyBucketCommand(config)).toMatchObject({
      command: "wal-g",
      args: ["st", "ls", "s3://libya-pg-backups-primary/prod"],
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
    expect(buildBarmanCheckCommand(config).args).toEqual(["check", "primary"]);
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
