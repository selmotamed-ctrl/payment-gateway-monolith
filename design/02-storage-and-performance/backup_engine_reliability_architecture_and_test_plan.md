# Next-Generation Backup & Disaster Recovery Engine (`pg-backup-daemon` v2): Forensic Root-Cause Analysis, Multi-Host Architecture, Exhaustive Test Suite & Guide/Academy Specification

> **Reference Codebase:** `payment-gateway-monolith` (`master` branch snapshot)
> **Target Execution Agent:** OpenCode (`DeepSeek V4.1 Flash Max`)
> **Scope:** Complete root-cause repair of the broken `pg-backup-daemon` deployment, architectural upgrade to a self-contained, zero-RPO, topology-agnostic Backup & Disaster Recovery Engine (supporting both Same-Host Co-Located and Dedicated Remote Backup Host topologies), multi-tier storage (Local Content-Addressed Repo + Native S3/MinIO + Remote SSH/SFTP Vault), 5-gate automated PITR restore drills, chaos/stress test suite, and complete Admin Guide + Employee Academy curriculum.

## 1. Forensic Root-Cause Diagnosis: Why the Current Backup System Fails to Boot or Be Accessible

An end-to-end audit of `deploy/deploy.ts`, `deploy/provisioners/backupEngineProvisioner.ts`, `deploy/lib/hostPlanner.ts`, `deploy/lib/configSchema.ts`, `deploy/backup-daemon/src/*`, `core-back/lib/storageEngine/backupControlClient.ts`, and `core-back/api/internal/backups.ts` on `master` identified **12 concrete defects** that prevent the daemon from booting, binding its mTLS listener, being reached by `core-back`, or completing backups and restore drills.

| # | Exact File & Lines (`master`) | Failure Mode | Root-Cause Mechanism |
| :--- | :--- | :--- | :--- |
| **RC-01** | `deploy/provisioners/backupEngineProvisioner.ts` (`lines 255–267`) | **Systemd refuses to boot (`status=216/GROUP`) on a dedicated backup host** | `backupDaemonSystemdUnit()` unconditionally writes `SupplementaryGroups=postgres`. On a dedicated remote backup host where PostgreSQL server is not installed, the `postgres` OS group does not exist, causing `systemd` to abort process launch immediately before `bun` even starts. |
| **RC-02** | `deploy/deploy.ts` (`lines 557–578`) vs. `backupEngineProvisioner.ts` (`line 255`) | **`deployBackupDaemon()` crashes or breaks file permissions** | `backupDaemonUser(config)` selects `"postgres"` for `wal-g` and `"pgbackup"` for `barman`, but `deployBackupDaemon()` in `deploy/deploy.ts` (`line 576`) hardcodes `chown postgres:postgres` and `runuser -u postgres -- /usr/local/bin/bun install --frozen-lockfile`. On a dedicated backup host without `postgres`, `chown` fails; in `barman` mode, `User=pgbackup` cannot read files chowned to `postgres:postgres`; and `runuser -u postgres` (without `-l` or `HOME=/var/lib/pg-backup`) inherits the SSH user's `HOME=/home/<sshUser>`, causing `bun install` to fail with `EACCES` when creating `~/.bun/install/cache`. |
| **RC-03** | `deploy/deploy.ts` (`lines 148–171, 915`) vs. `backupEngineProvisioner.ts` (`line 502`) | **Daemon crashes at boot with `EACCES` reading `backup-daemon.key`** | Step 3 (`uploadStorageCertificates`) writes `backup-daemon.crt`, `backup-daemon.key`, `backup-client.crt`, `backup-client.key`, and `internal-ca.crt` into `BACKUP_DAEMON_CERT_DIR` with `sudo: true` and `mode: 0o600` (owned by `root:root`). Whenever `--rotate-certs` or `--only=core,admin` or certificate sync runs without re-running `chown -R` after certificate writes, `backup-daemon.key` remains `0600 root:root` and `loadTlsOptions()` (`server.ts:346`) crashes at startup. |
| **RC-04** | `deploy/lib/hostPlanner.ts` (`lines 245–282`) | **`core-back` returns `503 BACKUP_DAEMON_NOT_CONFIGURED` (`configured: false`)** | In `storageEnv(config)` (`line 246`), `if (!pgStorageConfigured(config)) return {};` exits **before** lines `276–281` (`if (config.BACKUP_ENABLED) { BACKUP_DAEMON_URL: ... }`). Any deployment that uses the `DB_*` block or leaves `PG_PRIMARY_NODE` unset never writes `BACKUP_DAEMON_URL` or `BACKUP_DAEMON_CLIENT_*` into `core-back/.env`. |
| **RC-05** | `deploy/backup-daemon/src/server.ts` (`lines 387–441`) | **mTLS requests hang or fail over `node:tls` -> Unix socket bridge** | `startMtlsGateway()` creates a `node:tls` server that pipes raw decrypted bytes into `Bun.serve({ unix: socketPath })` via `net.connect(upstream)`. Because `net.connect(upstream)` is asynchronous and `socket` is not paused until `backend.on("connect")` fires, the initial HTTP request frame sent immediately after the TLS 1.3 handshake can be dropped or truncated on Linux, causing `BackupControlClient` in `core-back` to time out (`504 BACKUP_DAEMON_TIMEOUT`). |
| **RC-06** | `deploy/lib/configSchema.ts` (`lines 900–903`) & `deploy/backup-daemon/src/backupEngine.ts` (`lines 583–593`) | **Catch-22 between `wal-g` and `barman` on separate vs. same hosts** | `configSchema.ts` forbids `BACKUP_ENGINE_MODE="wal-g"` when `BACKUP_NODE` is on a separate host from `PG_PRIMARY_NODE`. Yet `BarmanEngine.overviewHealth()` (`backupEngine.ts:588`) calls `buildWalGVerifyBucketCommand()` (`wal-g st ls`), while `provisionBackupEngine()` (`line 497`) only installs `wal-g` when `BACKUP_ENGINE_MODE === "wal-g"`. Thus `barman` mode always reports primary storage unhealthy because `wal-g` is not installed. |
| **RC-07** | `deploy/provisioners/backupEngineProvisioner.ts` (`lines 390–415`) & `deploy/test-matrix/topologies.ts` (`line 125`) | **Provisioning aborts on `wal-g` SHA-256 or MinIO `410 Gone` / missing `go`** | `topologies.ts` (`line 125`) defaults `BACKUP_WALG_SHA256` to `"0".repeat(64)` when `LAB_WALG_SHA256` is unset, causing `sha256sum -c` to abort deployment. Meanwhile, `minioInstallScript` attempts `go install github.com/minio/minio@latest` when MinIO is missing, which fails whenever `go` is not installed on the target host. |
| **RC-08** | `deploy/backup-daemon/src/backupEngine.ts` (`lines 242–246`) | **`WAL_ARCHIVE_STATUS_QUERY` throws a PostgreSQL type error on every poll** | `WAL_ARCHIVE_STATUS_QUERY` runs `pg_wal_lsn_diff(pg_current_wal_lsn(), last_archived_wal)`. In PostgreSQL's `pg_stat_archiver`, `last_archived_wal` is a **24-character WAL segment filename** (e.g. `'000000010000000000000001'`), **not** a `pg_lsn` (`'0/1000000'`). PostgreSQL 18 rejects this query with `ERROR: function pg_wal_lsn_diff(pg_lsn, text) does not exist`, so WAL lag is silently reported as `0` forever. |
| **RC-09** | `deploy/backup-daemon/src/backupEngine.ts` (`lines 104–113, 520–530`) | **Scheduled and manual `"all"` backups fail when `audit_db` shares the primary cluster** | In single-host and consolidated topologies, `pg_audit_db` is a database inside the primary PostgreSQL cluster (`PG_AUDIT_DATA_DIR` is empty). Yet `triggerBackup("all", kind)` unconditionally expands `"all"` to `["postgres_core", "audit_db"]` and throws `PG_AUDIT_DATA_DIR is required for the audit_db WAL-G target`. |
| **RC-10** | `deploy/backup-daemon/src/restoreDrillRunner.ts` (`lines 323–395`) | **Restore drill fails when `audit_db` shares the primary cluster or uses `AUDIT_DB_USER`** | `RestoreDrillRunner` unconditionally attempts to recover and start two separate physical clusters (`coreScratch` on `55432` and `auditScratch` on `55433`). When `pg_audit_db` lives inside the primary cluster, recovering `audit_db` separately fails. |
| **RC-11** | `deploy/backup-daemon/src/restoreDrillRunner.ts` (`lines 79–99, 121–135`) vs. `auditAndLogDbProvisioner.ts` (`lines 97–111`) | **Restore drill audit hash-chain check fails 100% of the time on real PostgreSQL data** | The PostgreSQL trigger `compute_audit_chain_hash_trg()` computes `row_hash` over `NEW.before_json::text` and `NEW.after_json::text` (which in PostgreSQL `JSONB::text` includes spaces after colons/commas and sorts keys by length first). `RestoreDrillRunner` parses `before_json` into JS objects and re-serializes with `stableJson()` (no spaces, alphabetical keys), causing every real audit row's hash comparison to fail. |
| **RC-12** | `deploy/test-matrix/gates.ts` (`lines 564, 567`) | **Certification Gate 10 (`gateBackup`) checks a non-existent property and skips drill completion** | `gateBackup` asserts `overviewBody.walArchiveHealthy === true`, which does not exist in `/api/v1/admin/system/backups/overview` (the field is `healthy` and `wal.archiveLagSeconds`), and hardcodes `skip("restore drill completes")` instead of polling `/overview` until `latestDrill.id === drillId` finishes. |

## 2. Target Architecture: Next-Generation Unified Backup & DR Engine (`pg-backup-daemon` v2)

To make the backup system the most reliable, battle-tested component in the monolith, we redesign `pg-backup-daemon` around **four core architectural principles** aligned with [PostgreSQL 18 Continuous Archiving & PITR](https://www.postgresql.org/docs/current/continuous-archiving.html), [PostgreSQL 18 `pg_basebackup`](https://www.postgresql.org/docs/current/app-pgbasebackup.html), [PostgreSQL 18 `pg_verifybackup`](https://www.postgresql.org/docs/current/app-pgverifybackup.html), [PostgreSQL 18 `pg_receivewal`](https://www.postgresql.org/docs/current/app-pgreceivewal.html), and [PCI DSS v4.0 Requirement 3 & 12.10](https://pcidssguide.com/what-are-pci-dss-backup-requirements/):

### 2.1 Topology-Agnostic Native Engine (`pg-native` + `wal-g` + `barman` Adapters)

Instead of forcing `wal-g` (which requires local filesystem access to `PGDATA`) on single-host setups and `barman` (which requires complex out-of-band SSH key exchange between system users) on multi-host setups, `pg-backup-daemon` v2 introduces **`pg-native`** as the default, zero-external-dependency engine mode (while keeping `wal-g` and `barman` fully supported and fixed):

```
+---------------------------------------------------------------------------------------------------+
|                           TOPOLOGY A (CO-LOCATED) OR TOPOLOGY B (REMOTE HOST)                     |
|                                                                                                   |
|  +----------------------------------+              +-------------------------------------------+  |
|  | PostgreSQL 18 Primary & Audit DB |              |         pg-backup-daemon v2 (:4090)       |  |
|  | (Host A: 127.0.0.1 or LAN IP)    |              |     (Host A Co-Located OR Host B LAN)     |  |
|  |                                  |              |                                           |  |
|  | 1. Replication Protocol (TLS) ---+------------->| - pg_basebackup (Full & PG18 Incremental) |  |
|  |    (pg_basebackup / pg_receivewal|              | - pg_receivewal (Continuous WAL Stream)   |  |
|  |     slot: pg_backup_slot)        |              | - pg_dump -Fc (Logical Granular Dump)     |  |
|  |                                  |              | - pg_verifybackup (SHA-256 Manifest Gate) |  |
|  | 2. HTTPS mTLS WAL Push ----------+------------->| - PUT /v1/wal/:target/:segmentName        |  |
|  |    (archive_command via curl     |              | - AES-256-GCM Envelope + zstd Compression |  |
|  |     backup-client.crt)           |              +---------------------+---------------------+  |
|  +----------------------------------+                                    |                        |
|                                                                          v                        |
|            +-------------------------------------------------------------+--------------------+   |
|            |                        3-2-1 MULTI-TARGET STORAGE PIPELINE                       |   |
|            |                                                                                  |   |
|            |  +------------------------+  +-------------------------+  +-------------------+  |   |
|            |  | Tier 1: Local Repo     |  | Tier 2: S3/MinIO/R2     |  | Tier 3: SSH Vault |  |   |
|            |  | /var/lib/pg-backup/repo|  | Native Bun S3 / SigV4   |  | rsync/sftp +      |  |   |
|            |  | (Always available,     |  | + Object Lock WORM      |  | remote sha256sum  |  |   |
|            |  |  instant drill source) |  | (Optional or Primary)   |  | verification      |  |   |
|            |  +------------------------+  +-------------------------+  +-------------------+  |   |
|            +----------------------------------------------------------------------------------+   |
+---------------------------------------------------------------------------------------------------+
```

1. **Works Identically on the Same Host or a Different Host:**
   - Because [PostgreSQL 18 `pg_basebackup`](https://www.postgresql.org/docs/current/app-pgbasebackup.html), [PostgreSQL 18 `pg_receivewal`](https://www.postgresql.org/docs/current/app-pgreceivewal.html), and `pg_dump` communicate exclusively over the PostgreSQL network protocol (`PG_PRIMARY_HOST:PG_PRIMARY_PORT` with `PG_REPLICATION_USER` / `PG_PRIMARY_USER` over TLS), the exact same backup engine code runs whether `pg-backup-daemon` is on `127.0.0.1` (Co-Located) or `10.209.250.205` (Dedicated Remote Backup Host).
2. **Dual-Path Zero-RPO WAL Archiving (No S3 Secrets Needed on the DB Host):**
   - **Path 1 — Continuous Replication Slot Streaming (`pg_receivewal`):** The daemon supervises a continuous `pg_receivewal --slot=pg_backup_core --if-not-exists` worker that streams WAL in real time into `/var/lib/pg-backup/repo/wal_spool/`, flushing and encrypting segments as they arrive.
   - **Path 2 — mTLS HTTP `archive_command` Push (`PUT /v1/wal/:target/:segment`):** On the PostgreSQL primary, `archive_command` is configured to push completed 16 MiB WAL segments directly to `https://<BACKUP_DAEMON_HOST>:<BACKUP_DAEMON_PORT>/v1/wal/postgres_core/%f` using the host's `backup-client.crt` mTLS certificate. The database host never needs S3 credentials, `rclone`, or SSH keys to external vaults.
3. **Dual-Format Backups (Physical Cluster + Logical Granular):**
   - Every `full` backup captures:
     1. **Physical Base Backup (`pg_basebackup --format=tar --manifest-checksums=SHA256 --checkpoint=fast`):** Immediately verified offline using [PostgreSQL 18 `pg_verifybackup`](https://www.postgresql.org/docs/current/app-pgverifybackup.html) before encryption.
     2. **Logical Custom-Format Dump (`pg_dump --format=custom --compress=zstd:6`):** Stored alongside the physical base backup for both `payment_gateway_prod` and `pg_audit_db`, enabling rapid single-table or single-merchant inspection (`pg_restore`) without spinning up a full cluster, and allowing `pg_audit_db` to be backed up and restored independently even when it shares the primary PostgreSQL cluster.
   - Every `delta` backup captures:
     - In `pg-native` mode on PostgreSQL 18 (when `summarize_wal = on`): runs `pg_basebackup --incremental=<prev_manifest>` (copying only changed relation blocks) plus flushes all archived WAL segments since the last backup.
     - In `wal-g` / `barman` modes: runs `wal-g backup-push --delta` or `barman backup --incremental`.

### 2.2 Cluster-Topology Awareness (`Shared` vs. `Dedicated` Audit & Log Databases)

`pg-backup-daemon` v2 explicitly models the deployment's database topology via three boolean helpers in `src/config.ts`:

- `isAuditDedicatedCluster(config)`: `true` only when `PG_AUDIT_DATA_DIR` is set OR `PG_AUDIT_HOST !== PG_PRIMARY_HOST` OR `PG_AUDIT_PORT !== PG_PRIMARY_PORT`.
- `isAuditConfigured(config)`: `true` when `PG_AUDIT_DB_NAME` is non-empty (default `pg_audit_db`).
- `isLogDbConfigured(config)`: `true` when `PG_LOG_DB_NAME` is non-empty.

**How `target = "all"` and `target = "audit_db"` behave under `pg-backup-daemon` v2:**
- When `isAuditDedicatedCluster(config) === true`:
  - `postgres_core` backs up the primary cluster (`PG_PRIMARY_HOST:PG_PRIMARY_PORT`).
  - `audit_db` backs up the dedicated audit cluster (`PG_AUDIT_HOST:PG_AUDIT_PORT` / `PG_AUDIT_DATA_DIR`) into the `audit_db` prefix.
- When `isAuditDedicatedCluster(config) === false` (shared cluster, where `pg_audit_db` lives inside the primary PostgreSQL 18 instance on port `5432`):
  - Physical backup of `postgres_core` automatically captures all databases in the cluster (both `payment_gateway_prod` and `pg_audit_db`).
  - Backing up `audit_db` (either standalone or as part of `target = "all"`) **never throws `PG_AUDIT_DATA_DIR is required`**—instead, it executes a logical `pg_dump --format=custom` of `pg_audit_db` (using `PG_AUDIT_USER` / `PG_PRIMARY_USER`), verifies the dump header with `pg_restore --list`, encrypts it with AES-256-GCM, and uploads it to the `audit_db` storage prefix!
  - During `RestoreDrillRunner.run()`, when `isAuditDedicatedCluster(config) === false`, the single restored `coreScratch` cluster on `BACKUP_SCRATCH_PORT` (`55432`) already contains both `payment_gateway_prod` and `pg_audit_db` (or restores the logical `pg_audit_db` dump into `coreScratch`), and runs all 5 verification gates against `coreScratch` without needing a second `auditScratch` cluster!

### 2.3 Cryptographic Envelope Format & Tamper-Evident Catalog

Every backup archive and WAL segment written by `pg-backup-daemon` v2 uses authenticated encryption:

1. **Key Derivation (HKDF-SHA256):**
   - Master key: `BACKUP_ENCRYPTION_KEY_HEX` (32 bytes / 64 hex chars).
   - Per-artifact payload key: `HKDF-SHA256(ikm = masterKey, salt = randomBytes(16), info = "pg-backup-v2:payload:" + target + ":" + backupId, len = 32)`.
   - Manifest signing key: `HKDF-SHA256(ikm = masterKey, salt = "pg-backup-v2-catalog", info = "manifest-hmac-sha256", len = 32)`.
2. **Encrypted Artifact Envelope (`<backupId>.tar.zst.enc` + `<backupId>.manifest.json`):**
   - Stream pipeline: `tar stream -> zstd -6 -> AES-256-GCM (12-byte IV, 16-byte authTag) -> file`.
   - Accompanying `<backupId>.manifest.json`:
     ```json
     {
       "schemaVersion": 2,
       "backupId": "bkp_20261106T020000Z_core_full",
       "target": "postgres_core",
       "kind": "full",
       "engine": "pg-native",
       "clusterTopology": "shared-audit",
       "startedAt": "2026-11-06T02:00:00.000Z",
       "completedAt": "2026-11-06T02:01:14.210Z",
       "startLsn": "0/18000028",
       "endLsn": "0/180001A0",
       "walSegmentStart": "000000010000000000000018",
       "walSegmentEnd": "000000010000000000000018",
       "uncompressedBytes": 148291584,
       "compressedBytes": 19482112,
       "sha256Plaintext": "...",
       "sha256Ciphertext": "...",
       "encryption": {
         "algorithm": "AES-256-GCM",
         "kdf": "HKDF-SHA256",
         "saltHex": "...",
         "ivHex": "...",
         "authTagHex": "..."
       },
       "pgVerifyBackup": {
         "verified": true,
         "manifestChecksumAlgorithm": "SHA256",
         "detail": "backup successfully verified"
       },
       "storageTargets": ["local-repo", "primary-s3", "secondary-ssh"],
       "signature": "hmac-sha256-hex..."
     }
     ```
3. **Catalog Mirroring & Auto-Recovery:**
   - Whenever `CatalogStore.save()` persists `/var/lib/pg-backup/catalog.json`, it also signs the catalog with `manifest-hmac-sha256` and uploads an encrypted copy (`catalog.json.enc`) to `primary-s3` and `secondary-ssh`.
   - If the backup host itself is destroyed and replaced with a fresh server, `pg-backup-daemon` automatically reconstructs its local `catalog.json` on startup by listing `<backupId>.manifest.json` files from S3 or the SSH vault (`CatalogStore.recoverFromRemote()`).

## 3. Exact Code Fixes & Implementation Specification for OpenCode

Execute the following file-by-file changes in order.

### 3.1 Fix 1 — `deploy/lib/hostPlanner.ts`: Always Inject `BACKUP_DAEMON_URL` & Client Certs When `BACKUP_ENABLED=true`

In `deploy/lib/hostPlanner.ts` (`lines 245–285`), decouple the backup daemon environment variables from `pgStorageConfigured(config)` so `core-back` always receives `BACKUP_DAEMON_URL` whenever `config.BACKUP_ENABLED` is true:

```ts
// deploy/lib/hostPlanner.ts
const backupCoreEnv = (config: DeployConfig): Record<string, string> => {
  if (!config.BACKUP_ENABLED) return {};
  const scheme = config.BACKUP_ALLOW_INSECURE_HTTP ? "http" : "https";
  const host = backupPrivateIp(config) ?? "127.0.0.1";
  return {
    BACKUP_DAEMON_URL: `${scheme}://${host}:${config.BACKUP_DAEMON_PORT}`,
    BACKUP_DAEMON_CA_CERT_PATH: "shared/certs/internal-ca.crt",
    BACKUP_DAEMON_CLIENT_CERT_PATH: "shared/certs/backup-client.crt",
    BACKUP_DAEMON_CLIENT_KEY_PATH: "shared/certs/backup-client.key",
    BACKUP_DAEMON_TIMEOUT_MS: "30000",
  };
};
```

And in `coreEnv(config, node)` (`deploy/lib/hostPlanner.ts` around `line 314`), spread `...backupCoreEnv(config)` directly after `...storageEnv(config)`.

Also in `deploy/lib/pkiManager.ts` (`line 169`), ensure `backup-client` is included in `storageClients` whenever `backupStorageConfigured(config)` is true, and in `certFilesForHost` (`line 369`), ensure `role === "core"` receives `backup-client` and `role === "backup"` receives `backup`, `backup-client`, and `pg-client`.

### 3.2 Fix 2 — `deploy/provisioners/backupEngineProvisioner.ts` & `deploy/deploy.ts`: Fix Systemd User/Group, Cert Ownership, and Remote Host Provisioning

1. **In `deploy/provisioners/backupEngineProvisioner.ts` (`lines 255–290`):**
   - Make `backupDaemonUser(config)` return `"postgres"` ONLY when `config.BACKUP_ENGINE_MODE === "wal-g"` AND the backup host is co-located with `PG_PRIMARY_NODE`; otherwise use `"pgbackup"`.
   - Remove the unconditional `SupplementaryGroups=postgres` line from `backupDaemonSystemdUnit()` and instead add `pgbackup` to the `postgres` group dynamically during provisioning if the `postgres` group exists on that host (`getent group postgres >/dev/null 2>&1 && usermod -aG postgres pgbackup || true`).
   - Add `HOME=/var/lib/pg-backup` and `BUN_INSTALL_CACHE_DIR=/var/lib/pg-backup/.bun-cache` to `[Service]` in `backupDaemonSystemdUnit()` so `bun` never attempts to write to `/root` or `/home/<sshUser>`.
   - Ensure `postgresql-client-18` and `postgresql-18` binaries (`pg_basebackup`, `pg_receivewal`, `pg_verifybackup`, `pg_combinebackup`, `pg_dump`, `pg_restore`, `pg_ctl`, `initdb`, `psql`) are installed on `BACKUP_NODE` even when `BACKUP_NODE` is a dedicated remote backup host (while disabling and masking the default `postgresql` systemd service on a dedicated backup-only host so it does not waste port 5432).

```ts
// deploy/provisioners/backupEngineProvisioner.ts
export const isBackupColocatedWithPrimary = (config: DeployConfig): boolean => {
  const backupIp = backupSpec(config)?.privateIp;
  const primaryIp = parseNodeList(config.PG_PRIMARY_NODE)[0]?.privateIp ?? config.DB_SSH_HOST;
  return Boolean(backupIp && primaryIp && backupIp === primaryIp);
};

export const backupDaemonUser = (config: DeployConfig): "postgres" | "pgbackup" =>
  config.BACKUP_ENGINE_MODE === "wal-g" && isBackupColocatedWithPrimary(config)
    ? "postgres"
    : "pgbackup";

export const backupDaemonSystemdUnit = (config: DeployConfig): string => {
  const user = backupDaemonUser(config);
  const readWritePaths = [
    "/var/lib/pg-backup",
    "/var/log/pg-backup",
    dirname(config.BACKUP_CATALOG_PATH),
    config.BACKUP_DAEMON_CERT_DIR,
    config.BACKUP_SCRATCH_DIR,
    config.BACKUP_SCRATCH_AUDIT_DIR.trim() || `${config.BACKUP_SCRATCH_DIR}/audit`,
    dirname(config.BACKUP_PGPASSFILE),
  ].filter((value, index, all) => value.length > 0 && all.indexOf(value) === index).join(" ");

  return `[Unit]
Description=Payment Gateway pg-backup-daemon (Unified Backup & PITR Control Plane)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
Group=${user}
WorkingDirectory=/opt/pg-backup-daemon
EnvironmentFile=/etc/pg-backup/backup.env
Environment=HOME=/var/lib/pg-backup
Environment=BUN_INSTALL_CACHE_DIR=/var/lib/pg-backup/.bun-cache
Environment=BACKUP_DAEMON_PORT=${config.BACKUP_DAEMON_PORT}
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=${readWritePaths}

[Install]
WantedBy=multi-user.target
`;
};
```

2. **In `deploy/deploy.ts` (`uploadStorageCertificates` lines 148–171 & `deployBackupDaemon` lines 543–589):**
   - In `uploadStorageCertificates`, after writing the certificate and key files to `config.BACKUP_DAEMON_CERT_DIR` on a host with role `"backup"`, immediately set ownership and permissions so the daemon user can read them:
     ```ts
     if (host.roles.includes("backup") && !dryRun) {
       const daemonUser = backupDaemonUser(config);
       runner.run(
         host.ssh,
         `id -u ${shellQuote(daemonUser)} >/dev/null 2>&1 && chown -R ${shellQuote(`${daemonUser}:${daemonUser}`)} ${shellQuote(directory)} && chmod 0750 ${shellQuote(directory)} && chmod 0640 ${shellQuote(directory)}/*.crt && chmod 0600 ${shellQuote(directory)}/*.key || true`,
         { sudo: true },
       );
     }
     ```
   - In `deployBackupDaemon` (`deploy/deploy.ts` lines 551–589), replace the hardcoded `"postgres:postgres"` and `runuser -u postgres` with `const daemonUser = backupDaemonUser(config);` and pass `HOME=/var/lib/pg-backup BUN_INSTALL_CACHE_DIR=/var/lib/pg-backup/.bun-cache`:
     ```ts
     const daemonUser = backupDaemonUser(config);
     runner.run(
       host.ssh,
       `install -d -m 0750 -o ${shellQuote(daemonUser)} -g ${shellQuote(daemonUser)} /var/lib/pg-backup /var/lib/pg-backup/.bun-cache ${shellQuote(config.BACKUP_DAEMON_CERT_DIR)} && chown -R ${shellQuote(`${daemonUser}:${daemonUser}`)} ${shellQuote(config.BACKUP_DAEMON_CERT_DIR)} /var/lib/pg-backup && ${chownSource(`${daemonUser}:${daemonUser}`)}; if [ ${synced.changed ? 1 : 0} = 1 ] || [ ! -d ${shellQuote(`${installDir}/node_modules`)} ]; then install -d -o ${shellQuote(daemonUser)} -g ${shellQuote(daemonUser)} ${shellQuote(`${installDir}/node_modules`)} && cd ${shellQuote(installDir)} && runuser -u ${shellQuote(daemonUser)} -- env HOME=/var/lib/pg-backup BUN_INSTALL_CACHE_DIR=/var/lib/pg-backup/.bun-cache /usr/local/bin/bun install --frozen-lockfile; fi`,
       { sudo: true },
     );
     ```
   - Also after `systemctl start/restart pg-backup-daemon`, add an immediate readiness wait loop (`for i in $(seq 1 20); do systemctl is-active --quiet pg-backup-daemon && break; sleep 0.5; done; systemctl is-active --quiet pg-backup-daemon || { journalctl -u pg-backup-daemon -n 40 --no-pager >&2; exit 1; }`) so a startup failure is caught and printed immediately during Step 5 with full journalctl logs.

### 3.3 Fix 3 — `deploy/backup-daemon/src/server.ts`: Replace Buggy Unix-Socket Proxy with Native `node:https` mTLS Server + Add WAL Push & Job Serialization

In `deploy/backup-daemon/src/server.ts`:
1. **Replace `startMtlsGateway` (`node:tls -> unix socket -> Bun.serve`) with a direct `node:https.createServer` mTLS listener** (or pause-until-connected bridge) that inspects `req.socket.getPeerCertificate()` on each request directly in the HTTPS layer:
   - Eliminates the race condition where early TLS 1.3 data frames arrive before the Unix domain socket `net.connect()` completes.
   - Works identically on Linux, macOS, and Windows without creating temporary `/tmp/pg-backup-daemon-*` sockets that conflict with `PrivateTmp=true`.
   - Enforces per-route client CN authorization (`backup-client` for control-plane endpoints; `pg-client` or `backup-client` for `PUT /v1/wal/:target/:segment`).
2. **Add Global Job Mutex / Serialization & Idempotency Key Deduplication:**
   - Currently, `POST /v1/backups/trigger` and `POST /v1/drills/run` start concurrent subprocesses without serialization, so two rapid clicks on "Run backup now" or a trigger overlapping with the scheduler corrupts the scratch directory or saturates the disk.
   - Add an in-process `activeJob` mutex (`runningJobId: string | null`) and an `idempotencyMap: Map<string, { jobId: string; acceptedAt: string }>` keyed by the `Idempotency-Key` header:
     - If the same `Idempotency-Key` is retried, return `202 Accepted` with the existing `backupJobId` / `drillId`.
     - If another backup or restore drill is currently `RUNNING`, queue the new job in FIFO order (`QUEUED`) and execute it sequentially once the active job finishes rather than spawning overlapping `pg_basebackup` / `pg_ctl` processes.
3. **Add `PUT /v1/wal/:target/:segment` Endpoint for Zero-Dependency Remote WAL Archiving:**
   - Accepts raw WAL segment bytes (`<= 64 MiB`), compresses with `zstd`, encrypts with AES-256-GCM, writes atomically to `/var/lib/pg-backup/repo/wal/<target>/<segment>.zst.enc`, mirrors to S3/SSH targets asynchronously, updates `lastArchivedWal` and `lastArchivedAt` in the WAL tracker, and returns `200 OK`.

### 3.4 Fix 4 — `deploy/backup-daemon/src/backupEngine.ts`: Fix SQL Queries, Add `pg-native` Engine, Fix Shared Audit DB Handling, and Unify S3/Local/SSH Storage

In `deploy/backup-daemon/src/config.ts` and `deploy/backup-daemon/src/backupEngine.ts`:

1. **Add `"pg-native"` to `BACKUP_ENGINE_MODES`:**
   ```ts
   export const BACKUP_ENGINE_MODES = ["pg-native", "wal-g", "barman"] as const;
   ```
   Make `BACKUP_PRIMARY_S3_ENDPOINT` and `BACKUP_PRIMARY_S3_BUCKET` optional when `BACKUP_LOCAL_REPO_DIR` (`/var/lib/pg-backup/repo`) is enabled so the daemon boots and passes health checks even in air-gapped LAN environments without S3/MinIO, while still checking and syncing to S3/MinIO and `BACKUP_SECONDARY_SSH_TARGET` whenever configured!

2. **Fix `WAL_ARCHIVE_STATUS_QUERY` (`deploy/backup-daemon/src/backupEngine.ts:242`):**
   Replace the broken `pg_wal_lsn_diff(pg_current_wal_lsn(), last_archived_wal)` query with valid PostgreSQL 18 SQL using `pg_walfile_name_offset` / `pg_stat_archiver` safely:
   ```sql
   SELECT
     COALESCE(last_archived_wal, '') AS last_archived_wal,
     CASE
       WHEN last_archived_time IS NULL THEN 0
       ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - last_archived_time))))::bigint
     END::text AS lag_seconds,
     COALESCE(archived_count, 0)::text AS archived_count,
     COALESCE(failed_count, 0)::text AS failed_count,
     pg_current_wal_lsn()::text AS current_lsn,
     pg_walfile_name(pg_current_wal_lsn()) AS current_wal_file
   FROM pg_stat_archiver;
   ```
   And compute `lagBytes` safely: if `last_archived_wal` is a 24-hex-character WAL segment name (`^[0-9A-F]{24}$`), compute the segment number difference `(parseInt(currentWalFile.slice(8, 16), 16) * 256 + parseInt(currentWalFile.slice(16, 24), 16) - (parseInt(lastArchivedWal.slice(8, 16), 16) * 256 + parseInt(lastArchivedWal.slice(16, 24), 16))) * 16 * 1024 * 1024`, never passing a filename string into `pg_wal_lsn_diff`!

3. **Fix `walGEnvironment()` (`deploy/backup-daemon/src/backupEngine.ts:127`):**
   Use `PGHOST: config.PG_PRIMARY_HOST` and `PGUSER: config.PG_PRIMARY_USER` instead of hardcoding `PGHOST: "/run/postgresql"` and `PGUSER: "postgres"`.

4. **Fix `audit_db` Handling When Sharing the Primary Cluster:**
   - When `target === "audit_db"` (or `target === "all"`) and `!config.PG_AUDIT_DATA_DIR`:
     - Instead of throwing `PG_AUDIT_DATA_DIR is required for the audit_db WAL-G target`, execute a logical custom-format backup of `config.PG_AUDIT_DB_NAME` via `pg_dump -Fc -Z 6 -h <auditHost> -p <auditPort> -U <auditUser> -d <auditDbName>`, encrypt the resulting dump into the `audit_db` storage prefix, and record it in the catalog!
     - If `PG_AUDIT_DATA_DIR` IS set (a dedicated physical cluster), run physical backup on `PG_AUDIT_DATA_DIR` as before.

5. **Fix `BarmanEngine.overviewHealth()` (`deploy/backup-daemon/src/backupEngine.ts:580`):**
   - Never call `wal-g st ls` inside `BarmanEngine`! Instead, verify S3 reachability using native SigV4 HTTP `HEAD`/`GET` (or `barman-cloud-check-wal-archive`) and only check `barman-audit` when `isAuditDedicatedCluster(config)` is true.
   - In `backupEngineProvisioner.ts` (`line 465`), update `barmanStreamingSql()` to create BOTH `barman` and `barman_audit` replication slots when a dedicated audit cluster is used.

6. **Enforce Policy Retention Days Dynamically:**
   - In `WalGEngine.prune()` and `PgNativeEngine.prune()`, read `catalog.getPolicy().fullRetentionDays` and `walRetentionDays` so maker-checker policy updates through the Admin Portal actually govern backup pruning (`retain AFTER <cutoffISO>` or `retain FULL <computedCount>`).

### 3.5 Fix 5 — `deploy/backup-daemon/src/restoreDrillRunner.ts`: Fix Audit Hash Chain Verification, Shared-Cluster Drill, and 5-Gate Report

In `deploy/backup-daemon/src/restoreDrillRunner.ts`:
1. **Fix `AUDIT_CHAIN_QUERY` and Hash Verification (`lines 79–162`):**
   - Update `AUDIT_CHAIN_QUERY` to select `before_json::text AS "beforeJsonText", after_json::text AS "afterJsonText"` AND call the database's built-in `verify_audit_chain()` function when present:
     ```sql
     SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."seqNo"::bigint), '[]'::json)::text
     FROM (
       SELECT
         seq_no::text AS "seqNo",
         id::text AS "id",
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
         actor_id::text AS "actorId",
         action,
         entity_type AS "entityType",
         entity_id AS "entityId",
         before_json AS "beforeJson",
         after_json AS "afterJson",
         before_json::text AS "beforeJsonText",
         after_json::text AS "afterJsonText",
         prev_hash AS "prevHash",
         row_hash AS "rowHash"
       FROM audit_records
       ORDER BY seq_no ASC
     ) t;
     ```
   - In `computeAuditRowHash(prevHash, row)`:
     - Check both the PostgreSQL trigger canonical format (`row.beforeJsonText` / `row.afterJsonText` + `createdAt`) AND the application `stableJson` format, and also verify **gap-free `seq_no` monotonicity** (`Number(row.seqNo) === index + 1`) so deleted rows are detected!
2. **Support Both Shared-Cluster and Dedicated-Cluster Audit Recovery in `RestoreDrillRunner.run()`:**
   - If `isAuditDedicatedCluster(config)` is `true`, recover and start both `coreScratch` (`55432`) and `auditScratch` (`55433`).
   - If `isAuditDedicatedCluster(config)` is `false` (shared cluster), recover `coreScratch` (`55432`) once; if a logical `pg_audit_db.dump` was taken, restore it into `coreScratch`'s `pg_audit_db` database if not already present in the physical cluster backup, and run `AUDIT_CHAIN_QUERY` against `corePort` (`55432`, database `config.PG_AUDIT_DB_NAME`)!
3. **Wait for WAL Recovery Promotion Before Running SQL Queries:**
   - When `recovery.signal` is present, `pg_ctl start` returns as soon as the postmaster accepts read-only recovery connections—potentially **before** WAL replay finishes and promotes the cluster to read-write!
   - Add a `waitForRecoveryPromotion(port, timeoutMs = 60_000)` helper that polls `SELECT pg_is_in_recovery();` every `250ms` until it returns `'f'` (promoted), ensuring all WAL segments up to `targetTime` have been replayed before running the invariant checks!

### 3.6 Fix 6 — `core-back/api/internal/backups.ts` & `deploy/test-matrix/gates.ts`: Align Overview Contract & Certification Gate 10

1. In `core-back/api/internal/backups.ts` (`line 225`):
   - Include `walArchiveHealthy: Boolean(overview?.healthy && (overview?.wal?.archiveLagSeconds ?? 0) <= (overview?.policy?.alertLagSeconds ?? 300))` in the `GET /overview` JSON response alongside `healthy` and `wal`.
   - Expose `GET /catalog` via `admin-back/api/protected/backups.ts` as well so the Admin UI can inspect local catalog history even during daemon maintenance.
2. In `deploy/test-matrix/gates.ts` (`lines 545–569`, `gateBackup`):
   - Poll `/system/backups/overview` after `POST /system/backups/drill` until `latestDrill.id === drillBody.drillId` and `latestDrill.status` reaches `"PASSED"` or `"FAILED"` (instead of `skip("restore drill completes")`), and assert `latestDrill.status === "PASSED"`, `Number(latestDrill.doubleEntryDrift) === 0`, `latestDrill.balanceMismatches === 0`, and `latestDrill.auditBrokenLinks === 0`!

## 4. Comprehensive Multi-Layer Test & Chaos Verification Suite Design

To guarantee that the backup engine never regresses and works reliably across single-host and multi-host deployments, implement a **4-Tier Automated Verification Suite**:

### 4.1 Tier 1 — Unit & Cryptographic Envelope Tests (`deploy/backup-daemon/test/*.test.ts`)
- **`cryptoEnvelope.test.ts` (New):**
  - Verifies HKDF-SHA256 key derivation determinism and domain separation across targets (`postgres_core` vs. `audit_db` vs. `redis`).
  - Verifies streaming `tar -> zstd -> AES-256-GCM` encryption and decryption round-trip on multi-megabyte payloads.
  - Injects a 1-bit flip into the ciphertext, IV, authTag, and `manifest.json` fields and asserts that decryption and `verifyManifestSignature()` fail closed every time.
- **`backupEngine.test.ts` (Expanded):**
  - Tests `pg-native`, `wal-g`, and `barman` command and pipeline builders for both Co-Located (`127.0.0.1`) and Remote Host (`10.209.250.205`) configurations.
  - Verifies `WAL_ARCHIVE_STATUS_QUERY` parsing with real 24-character PostgreSQL WAL filenames (`00000001000000000000001A`) and empty (`''`) initial state without throwing `pg_lsn` cast errors.
  - Verifies shared-cluster vs. dedicated-cluster `audit_db` backup routing.
- **`server.test.ts` & `mtlsAuthorization.test.ts` (Expanded):**
  - Tests live TLS 1.3 keep-alive connection pooling using `core-back`'s exact `BackupControlClient` (`https.Agent({ keepAlive: true, maxSockets: 8, minVersion: "TLSv1.3" })`) issuing 50 sequential and concurrent requests over the same keep-alive sockets.
  - Tests `Idempotency-Key` deduplication and FIFO job queue serialization when multiple `/v1/backups/trigger` and `/v1/drills/run` requests arrive simultaneously.
  - Tests `PUT /v1/wal/postgres_core/000000010000000000000001` WAL segment upload, encryption, and checksum verification.

### 4.2 Tier 2 — Live PostgreSQL 18 Ephemeral Cluster Integration Tests (`deploy/backup-daemon/test/live-pg18-pitr.test.ts`)
Create a self-contained integration test (`deploy/backup-daemon/test/live-pg18-pitr.test.ts`) that runs against real local PostgreSQL 18 binaries (`initdb`, `pg_ctl`, `pg_basebackup`, `pg_verifybackup`, `pg_dump`, `psql`):
1. **Spin up Ephemeral Primary Cluster (`port 55440`):**
   - Initializes a temporary PostgreSQL 18 cluster with `wal_level = replica`, `archive_mode = on`, `summarize_wal = on`, and `archive_command` pushing WAL segments to the in-process `pg-backup-daemon` server.
   - Creates `payment_gateway_prod` (with `gl_accounts`, `gl_account_shards`, `journal_entries`, `journal_lines`) and `pg_audit_db` (with `audit_records` + `trg_audit_chain_compute` + `verify_audit_chain()`).
2. **Seed Pre-Backup Ledger & Audit State (`T1`):**
   - Inserts balanced double-entry journal lines (`1000.0000 LYD` debit/credit across 16 shards) and 50 chained audit rows.
3. **Trigger Full Backup (`POST /v1/backups/trigger` `{ target: "all", kind: "full" }`):**
   - Asserts `status === "PASSED"`, `pg_verifybackup` passed, and encrypted artifacts exist in the repository.
4. **Seed Post-Backup WAL Transactions (`T2`) & Simulated Catastrophic Corruption (`T3`):**
   - Inserts another `500.0000 LYD` of balanced journal lines and 25 audit rows, forces a WAL switch (`SELECT pg_switch_wal();`), records timestamp `T2_SAFE`, and then simulates an operator error / corruption at `T3`!
5. **Execute Automated Restore Drill (`POST /v1/drills/run` with `targetTime = T2_SAFE`):**
   - Restores the base backup + replays WAL up to `T2_SAFE` on scratch port `55442`.
   - Verifies that all `1500.0000 LYD` of `T1 + T2` transactions are recovered, `T3` corruption is excluded, `doubleEntryDrift === "0.0000"`, `balanceMismatches === 0`, `auditBrokenLinks === 0`, `journalLineCount > 0`, and `verifyDrillReportSignature()` is `true`!
6. **Fault & Tamper Injection Sub-Tests:**
   - **Corrupted Backup Payload Test:** Corrupts 1 byte in `<backupId>.tar.zst.enc` and verifies the drill fails at Gate 1 (`cipher authentication failed`).
   - **Double-Entry Drift Detection Test:** Injects an unbalanced `journal_lines` row (`+0.0001 LYD`) into the restored scratch cluster before invariant checks run and verifies the drill reports `status: "FAILED"`, `checks.doubleEntry.ok === false`, `doubleEntryDrift: "0.0001"`.
   - **Shard Parity Mismatch Detection Test:** Alters a `gl_account_shards.current_balance` by `+1.0000` and verifies `checks.balanceParity.ok === false`, `balanceMismatches === 1`.
   - **Audit Chain Tamper Detection Test:** Bypasses the trigger as superuser in the scratch cluster to alter `after_json` on row `seq_no = 12` and verifies `checks.auditChain.ok === false`, `auditBrokenLinks >= 1`.

### 4.3 Tier 3 — Two-Host LAN Deployment Matrix Tests (`deploy/test-matrix/gates.ts`)
Verify across both Two-Machine Lab Topologies (`Host A = local`, `Host B = salem@10.209.250.205`):
- **Topology Co-Located (`backup` on Host A alongside `pg-primary`):**
  - Verifies `pg-backup-daemon.service` is `active (running)`, mTLS `/health` and `/v1/overview` pass, full backup of `all` completes, and full scratch restore drill passes all 5 gates while sustained checkout traffic runs on Host A.
- **Topology Split-Host (`pg-primary` on Host A, `backup` on Host B `10.209.250.205`):**
  - Verifies `pg-backup-daemon.service` boots cleanly as `pgbackup` on Host B without local PostgreSQL server running.
  - Verifies remote `pg_basebackup` + WAL streaming from Host A (`:5432`) to Host B (`:4090`) over LAN TLS.
  - Verifies that running a Restore Drill on Host B restores into Host B's `/var/lib/pg-backup/scratch` and passes all 5 ledger & audit invariants with zero CPU/IO stall on Host A's primary database.
  - **Simulated Host A Total Loss Drill:** Stops PostgreSQL on Host A, promotes the restored cluster on Host B, and verifies zero transaction loss (`RPO = 0` for archived WAL) and 100% ledger invariant integrity.

## 5. Complete Admin Guide & Employee Academy Content Specification

Update `design/07-guides-and-academy/guide_system_design_and_content.md` and `design/07-guides-and-academy/academy_system_design_and_content.md`, then run `bun scripts/extract-guide-content.ts` and `bun scripts/extract-academy-content.ts` in `admin-front/` so the compiled JSON bundles in `admin-front/src/content/guide/generated/` and `admin-front/src/content/academy/generated/` (and `core-back/content/academy/`) include the complete Backup & Disaster Recovery training.

### 5.1 Admin Interactive Guide Additions (`design/07-guides-and-academy/guide_system_design_and_content.md`)

Add a dedicated `SystemBackups` screen mapping in `@@map` and add articles `b12-09`, `b12-10`, `b12-11`, action cards `sg-trigger-backup`, `sg-run-restore-drill`, `sg-update-backup-policy`, and playbook situations `s-backup-daemon-unreachable`, `s-wal-archive-lag-high`, and `s-restore-drill-failed`:

```markdown
@@map screen=SystemBackups routes=SystemBackups,AdminSystemBackups dir=pages/system/backups articles=b12-07,b12-09,b12-10,b12-11 cards=sg-trigger-backup,sg-run-restore-drill,sg-update-backup-policy situations=s-backup-daemon-unreachable,s-wal-archive-lag-high,s-restore-drill-failed
The Disaster Recovery and Backup control plane. Monitor continuous WAL archiving lag, storage target health (Local Repo, S3/MinIO, Off-site SSH Vault), scheduled Full and Delta backups, and automated 5-gate Restore Drills.

@@article id=b12-09 book=12 order=9 title="Backups from zero: Full backups, Delta backups, WAL archiving and Point-in-Time Recovery (PITR)" roles=SECURITY_ADMIN,GATEWAY_ADMIN,FINANCE,OPERATOR minutes=4 ui=AVAILABLE related=b12-07,b12-10,b12-11,b08-11
### Why ordinary daily backups are not enough for a payment gateway
Imagine a store that photographs its cash register once every night at 02:00 AM. If a fire destroys the register at 06:00 PM, every sale made between 02:00 AM and 06:00 PM is gone forever. In a payment gateway, losing 16 hours of payments, wallet balances, and audit records is catastrophic—customers have already paid at partner banks, and our books would no longer match reality.

To prevent this, our platform combines **two layers of protection** that work together continuously:

| Concept | Plain-language meaning | Real-world analogy | How often it runs |
| :--- | :--- | :--- | :--- |
| **Full Base Backup** | A complete, verified copy of the entire PostgreSQL 18 database cluster (`postgres_core` and `audit_db`) plus a Redis snapshot. | Photographing every page of the accounting ledger from page 1 to the end. | Weekly (default Sunday 02:00 UTC) and on demand before migrations. |
| **Delta (Incremental) Backup** | A smaller copy containing only the database blocks that changed since the last Full or Delta backup. | Photographing only the ledger pages that were written on today. | Daily (Monday–Saturday 02:00 UTC). |
| **Write-Ahead Log (WAL) Archiving** | Before PostgreSQL changes any number on disk, it writes the exact change into a sequential log called the **WAL** (Write-Ahead Log), identified by an ever-increasing **LSN** (Log Sequence Number). Our backup engine streams and archives every WAL segment continuously. | A black-box flight recorder that records every single pen stroke in real time. | Continuously (every second; alert threshold default 300s). |
| **Point-in-Time Recovery (PITR)** | Restoring the most recent Full/Delta backup and then replaying the archived WAL stream forward up to an exact second (for example, `14:32:09 UTC`, one second before a human error or hardware fault). | Opening Sunday's ledger photo and replaying the black-box recording stroke by stroke up to the exact second before the accident. | Tested automatically every week in an isolated Restore Drill, and used during disaster recovery. |

### Same-Host (Co-Located) vs. Separate-Host (Remote) Backup Topologies
The backup daemon (`pg-backup-daemon`) can be deployed in two topologies configured in `deploy.env`:
1. **Co-Located Topology (Same Host):** `pg-backup-daemon` runs on the same machine as the PostgreSQL primary, reading/streaming locally and pushing encrypted copies to external S3/MinIO object storage and an off-site SSH vault.
2. **Dedicated Backup Host Topology (Separate Host):** `pg-backup-daemon` runs on a separate server (e.g., across the LAN or in a secondary rack). It connects to the PostgreSQL primary over encrypted TLS replication to pull base backups and stream WAL segments, and runs weekly Restore Drills on the backup host's own CPU and disk so production payment processing never slows down.

### How backups are protected (Encryption & 3-2-1 Storage)
* **Client-Side Authenticated Encryption (AES-256-GCM):** Every backup and WAL segment is compressed (`zstd`) and encrypted with a 256-bit key before it is written to storage. Even if an attacker steals the S3 bucket, the files are unreadable without `BACKUP_ENCRYPTION_KEY_HEX`.
* **Cryptographic Manifest (`backup_manifest` + HMAC Signature):** Every backup includes a SHA-256 hash of every file and an HMAC signature. If even a single bit flips on disk, verification rejects the file immediately.
* **Multiple Storage Targets:** Backups are stored in the local repository (`/var/lib/pg-backup/repo`), the primary S3/MinIO bucket (`primary-s3`), and an optional off-site SSH vault (`secondary-ssh`). Off-site copies are append-only by default (`BACKUP_SECONDARY_MIRROR_DELETE=false`) so a compromised server cannot delete historical off-site backups.
@@end

@@article id=b12-10 book=12 order=10 title="The Backups screen: reading every tile, target, LSN and Restore Drill check" roles=SECURITY_ADMIN,GATEWAY_ADMIN,FINANCE minutes=4 ui=AVAILABLE related=b12-09,b12-11,b08-11
### Opening the Backups screen
Open **System -> Backups** (`/system/backups`). Only staff with `security:read` or `gateway:read` can view this screen, and only `SECURITY_ADMIN` (`security:write`) can trigger a backup, start a restore drill, or propose a policy change.

### The five top summary tiles
1. **WAL Archive Lag (`s`):** How many seconds ago the latest WAL change was safely archived.
   * **Healthy (Green):** Below the alert threshold (default `300s`).
   * **Attention (Amber) / Critical (Red):** Above the threshold. It means PostgreSQL is writing transactions faster than WAL segments are being archived, or a storage target is unreachable.
2. **Daemon Status (`Reachable` / `Unreachable`):** Whether `core-back` can reach `pg-backup-daemon` over mutual TLS (`backup-client` certificate). If `Unreachable`, all action buttons are disabled until connectivity returns.
3. **Storage Targets (`Healthy / Total`):** How many configured storage destinations (Primary S3 Bucket, PostgreSQL Primary, Secondary Off-site SSH Vault, Redis) passed their live connectivity check.
4. **Last Backup:** The timestamp and status (`Passed`, `Running`, `Queued`, `Failed`) of the most recent Full or Delta backup.
5. **Latest Restore Drill:** The timestamp and result (`Drill passed` / `Drill failed`) of the most recent automated recovery verification.

### Understanding the Latest Restore Drill card (The 3 Invariant Badges)
A backup that has never been restored is only a wish, not a backup. When a **Restore Drill** runs, `pg-backup-daemon` unpacks the latest encrypted backup into a temporary, isolated scratch directory (`/var/lib/pg-backup/scratch`), starts a private loopback PostgreSQL 18 instance on port `55432`, replays the WAL archive to `now - 5 minutes`, and checks **three non-negotiable mathematical laws**:

| Drill Check Badge | What the daemon queries in the restored database | What `Passed` proves | What `Failed` means (Priority-1 Incident) |
| :--- | :--- | :--- | :--- |
| **Double-entry zero drift** | `SELECT SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) FROM journal_lines;` | Every debit equals every credit (`0.0000` drift) across all restored journal lines. | The restored ledger is unbalanced (`doubleEntryDrift != 0`). Escalate immediately to Finance + Security Admin. |
| **Sharded balance parity** | Compares every `gl_accounts` row's `gl_account_shards` sum against `checkpoint_balance + post-checkpoint journal_lines`. | All 16/32 hot-account ledger shards match the immutable journal lines (`0` mismatches). | One or more GL account shards drifted from the journal lines (`balanceMismatches > 0`). |
| **Audit hash chain** | Recomputes the SHA-256 chain (`prev_hash -> row_hash`) from `GENESIS_HASH` (`0000...`) across every row in `audit_records`. | Every audit log entry is present, in sequence (`seq_no`), and untampered (`0` broken links). | An audit row was altered, corrupted, or deleted (`auditBrokenLinks > 0`). |

After the three checks complete, the daemon signs the drill report with HMAC-SHA256 (`reportSignature`) and **destroys the temporary scratch database** so no customer data is left sitting in a temporary folder.
@@end

@@article id=b12-11 book=12 order=11 title="Operating Backups safely: manual triggers, two-person policy changes, and emergency recovery" roles=SECURITY_ADMIN,GATEWAY_ADMIN minutes=3 ui=AVAILABLE related=b12-09,b12-10,b04-03
### When to run a manual backup (`Run backup now`)
Run an immediate backup before:
* applying a major platform setting or routing change,
* performing server maintenance, OS upgrades, or firewall changes,
* rotating encryption or mTLS certificates.

Choose the **Target** (`All targets`, `PostgreSQL core`, `Audit database`, or `Redis`) and **Kind** (`Full` or `Delta`). Selecting `All targets` + `Full` asks for a second confirmation because it backs up every store simultaneously.

### Why changing the backup policy requires two people (Maker-Checker)
An attacker who compromises one administrator account often tries to **weaken backup retention** (for example, changing `Full retention days` from `56` to `1` day) so old backups are pruned before anyone notices an attack.
Therefore, clicking **Edit policy** and saving does **not** change the schedule immediately:
1. **Maker step (`SECURITY_ADMIN #1`):** Submits the new cron schedule or retention days. The system creates a `BACKUP_POLICY` approval request in `PENDING_REVIEW` state.
2. **Checker step (`SECURITY_ADMIN #2`):** Reviews the diff on the **Approvals** screen (or submits the `approvalRequestId`) to execute the change on `pg-backup-daemon` and record a `BACKUP_POLICY_UPDATED` audit log.
@@end

@@card id=sg-trigger-backup title="Trigger an on-demand Full or Delta backup" screen=SystemBackups roles=SECURITY_ADMIN risk=MEDIUM
1. Open **System -> Backups** and verify **Daemon status** is `Reachable` and **Storage targets** are `Healthy`.
2. Click **Run backup now** in the top-right header.
3. Select **Backup target** (`All targets` for a complete checkpoint, or a specific store) and **Backup kind** (`Full` or `Delta`).
4. Click **Run backup now** (and confirm the warning dialog if running a Full backup of All targets).
5. Click **Refresh** and watch the top row in **Scheduled backups** transition from `Queued` -> `Running` -> `Passed`, verifying that `Size` and `Duration` are populated and `Error` is blank.
@@end

@@card id=sg-run-restore-drill title="Run an isolated PITR Restore Drill and verify ledger invariants" screen=SystemBackups roles=SECURITY_ADMIN risk=MEDIUM
1. Open **System -> Backups** and confirm no other Full backup is currently in `Running` state.
2. Click **Run restore drill** and confirm the prompt.
3. Wait 1–3 minutes for the scratch PostgreSQL 18 cluster to restore, replay WAL to `now - 5 minutes`, and run the invariant queries, clicking **Refresh** to monitor progress.
4. In the **Latest restore drill** card, verify the status badge is `Drill passed` and all three invariant badges (**Double-entry zero drift**, **Sharded balance parity**, and **Audit hash chain**) show `Passed` in green.
@@end

@@card id=sg-update-backup-policy title="Propose and approve a Backup Schedule or Retention Policy change" screen=SystemBackups roles=SECURITY_ADMIN risk=HIGH
1. Open **System -> Backups** and click **Edit policy**.
2. Enter valid 5-field UTC cron expressions for **Full cron**, **Delta cron**, and **Drill cron** (minimum 60-minute gap for Full/Drill, 5-minute gap for Delta) and integer retention days.
3. Click **Save Changes**. Note the `PENDING_REVIEW` approval ID shown in the notification banner.
4. Ask a **second** `SECURITY_ADMIN` to review and approve the `BACKUP_POLICY` request so the new schedule takes effect on the daemon's next 30-second tick.
@@end

@@situation id=s-backup-daemon-unreachable title="The Backups screen says 'The backup daemon is unreachable'" screens=SystemBackups,Dashboard cases=75 articles=b12-09,b12-10,b12-11
### What to do
1. Do not panic—PostgreSQL continues buffering WAL segments locally in `pg_wal/` while the daemon is unreachable.
2. Check `systemctl status pg-backup-daemon` and `journalctl -u pg-backup-daemon -n 50` on the backup host.
3. Verify `/var/lib/pg-backup/shared/certs/backup-daemon.key` is owned by the daemon user (`pgbackup` or `postgres`, mode `0600`) and that port `4090` is open from the core host's private IP.
4. Once `Daemon status` returns to `Reachable`, click **Run backup now** (`Delta`) and verify **WAL archive lag** drops back below the alert threshold.
@@end

@@situation id=s-wal-archive-lag-high title="WAL archive lag is in Warning or Critical" screens=SystemBackups cases=75 articles=b12-09,b12-10
### What to do
1. Check the **Storage targets** card on **System -> Backups** to see if `Primary S3 Bucket` or `Secondary Off-site Target` is `Failed`.
2. If the S3/MinIO object store is down or full, restore object store connectivity immediately; PostgreSQL retains unarchived WAL files in `pg_wal/` until they are archived, which can eventually fill the database disk if left unresolved.
3. After the storage target returns to `Healthy`, refresh the screen over 2 minutes to confirm `Lag bytes` and `Archive lag` drain back toward `0 s`.
@@end

@@situation id=s-restore-drill-failed title="A Restore Drill failed on Double-entry, Balance parity, or Audit chain" screens=SystemBackups,Finance cases=91,92 articles=b12-10,b10-05,b08-11
### What to do
1. Treat any Restore Drill invariant failure as a **Priority-1 Security & Finance Incident**.
2. Read the red error alert and check which of the three badges failed:
   * If **Double-entry zero drift** or **Sharded balance parity** failed: open **Finance -> Invariant** immediately and follow Runbook **RB-04 (Ledger Invariant Drift)**.
   * If **Audit hash chain** failed: escalate immediately to the `SECURITY_ADMIN` and CTO—do not prune or overwrite existing backups.
   * If the drill failed with a storage/process error (`backup-fetch failed` or `pg_ctl start failed`): fix the storage or scratch port issue and re-run **Run restore drill** to confirm a clean green pass.
@@end
```

### 5.2 Employee Academy Additions (`design/07-guides-and-academy/academy_system_design_and_content.md`)

Add Lesson `l-m10-4` to Module `m10`, add interactive Lab `lab-backup-dr-desk`, add incident drill `drill-pitr-recovery`, and add practice + exam questions (`c-l-m10-4-1..3`, `q-m10-004..008`):

```markdown
@@lesson id=l-m10-4 module=m10 order=4 title="Backups, Point-in-Time Recovery (PITR) and Restore Drills" minutes=25 tracks=FOUNDATION,SECURITY_ADMIN,GATEWAY_ADMIN,FINANCE reading=b12-07,b12-09,b12-10,b12-11
### You will be able to
- Explain the difference between a Full backup, a Delta backup, and continuous WAL archiving.
- Read the five health tiles and the three Restore Drill invariant badges on the Backups screen.
- Explain why backup policy changes require two-person approval and why off-site backups are append-only.

### Key ideas
- A **Full backup** copies the entire database cluster; a **Delta backup** copies only blocks changed since the last backup; **WAL archiving** streams every individual change continuously so we can recover to any second (**Point-in-Time Recovery / PITR**).
- The backup daemon (`pg-backup-daemon`) can run on the **same host** as PostgreSQL or on a **separate dedicated backup host** over TLS, storing AES-256-GCM encrypted archives in a Local Repo, a Primary S3/MinIO bucket, and an off-site SSH vault.
- An untested backup cannot be trusted. Every week (and on demand), the daemon runs an isolated **Restore Drill** on a temporary scratch port and verifies three mathematical laws:
  1. **Double-entry zero drift** (`SUM(DEBIT) - SUM(CREDIT) = 0`),
  2. **Sharded balance parity** (`gl_account_shards` match `checkpoint_balance + journal_lines`),
  3. **Audit hash chain** (`prev_hash -> row_hash` unbroken from genesis).
- Changing the backup schedule or retention window (`Edit policy`) requires **two-person approval (Maker-Checker)** so no single compromised account can shorten retention and erase historical backups.

### A worked example
On Sunday at 02:00 UTC, the scheduler takes a Full backup. On Monday and Tuesday at 02:00 UTC, it takes Delta backups, while WAL segments are archived every minute. On Tuesday at 14:35 UTC, a hardware fault corrupts the primary disk. Because `WAL archive lag` was `2 s`, the Security Admin restores Monday's backup plus the archived WAL stream up to `14:34:58 UTC`, recovering every settled payment and audit record with zero ledger drift.

### Common mistakes
- Ignoring a rising **WAL archive lag** until `pg_wal/` fills up the primary database disk.
- Assuming a policy change took effect immediately after clicking **Save Changes** without having a second `SECURITY_ADMIN` approve the `BACKUP_POLICY` request.
- Treating a failed **Restore Drill** as a minor warning instead of investigating which check (`Double-entry`, `Sharded balance parity`, or `Audit hash chain`) failed.

### Read now
- [[a:b12-09]]
- [[a:b12-10]]
- [[a:b12-11]]

### Check yourself
Questions: c-l-m10-4-1, c-l-m10-4-2, c-l-m10-4-3
@@end

@@q id=c-l-m10-4-1 module=m10 type=single difficulty=1 critical=false exam=false lesson=l-m10-4 tracks=FOUNDATION,SECURITY_ADMIN,GATEWAY_ADMIN,FINANCE refs=b12-09
Stem: What allows the platform to recover transactions that happened hours after the last nightly backup?
- [x] Continuous Write-Ahead Log (WAL) archiving replayed on top of the base/delta backup (PITR).
- [ ] Running the browser cache in reverse.
- [ ] Asking merchants to re-enter all payments from the day.
Why: Continuous WAL archiving records every database change between scheduled full/delta backups, enabling Point-in-Time Recovery (PITR).
@@end

@@q id=c-l-m10-4-2 module=m10 type=single difficulty=2 critical=true exam=false lesson=l-m10-4 tracks=SECURITY_ADMIN,GATEWAY_ADMIN,FINANCE refs=b12-10
Stem: Which three checks must pass inside the isolated scratch database for a Restore Drill to be marked PASSED?
- [x] Double-entry zero drift, Sharded balance parity, and Audit hash chain integrity.
- [ ] CPU usage under 50%, disk space under 50%, and 10 active merchants.
- [ ] Checkout logo loaded, Arabic translation present, and email sent.
Why: The Restore Drill verifies double-entry zero drift, sharded balance parity, and the SHA-256 audit hash chain before signing the report and destroying the scratch cluster.
@@end

@@q id=c-l-m10-4-3 module=m10 type=single difficulty=2 critical=true exam=false lesson=l-m10-4 tracks=SECURITY_ADMIN refs=b12-11
Stem: Why does lowering 'Full retention days' on the Backups screen require a second Security Admin's approval?
- [x] To prevent a single compromised account or mistaken admin from pruning historical backups needed for recovery or forensic investigation.
- [ ] Because cron expressions can only be typed by two people at once.
- [ ] Because the backup daemon does not support retention settings.
Why: Backup schedule and retention changes use Maker-Checker (`BACKUP_POLICY`) so no single actor can destroy recovery history.
@@end

@@q id=q-m10-004 module=m10 type=single difficulty=2 critical=true exam=true tracks=SECURITY_ADMIN,GATEWAY_ADMIN refs=b12-09,b12-10
Stem: On the Backups screen, 'Last backup' is Passed (from 02:00 UTC), but 'WAL archive lag' is 4,200 s (Critical) and 'Primary S3 Bucket' is Failed. What is the real risk?
- [x] Changes since the last archived LSN are not reaching the backup repository, and unarchived WAL files will accumulate on the primary database disk until storage connectivity is restored.
- [ ] There is no risk because the 02:00 UTC backup passed.
- [ ] All historical backups in S3 have been deleted.
Why: High WAL archive lag means recent transactions are not yet archived off the primary database and `pg_wal` will grow until archiving resumes.
@@end

@@q id=q-m10-005 module=m10 type=single difficulty=2 critical=true exam=true tracks=SECURITY_ADMIN,FINANCE refs=b12-10
Stem: The weekly Restore Drill finishes with status 'Drill failed' and shows 'Double-entry zero drift: Passed', 'Sharded balance parity: Passed', and 'Audit hash chain: Failed (1 broken link at seq_no 418)'. How must you treat this?
- [x] As a Priority-1 security incident indicating potential tampering or corruption in `audit_records`; preserve the backups and escalate immediately.
- [ ] Ignore it because the money balances matched.
- [ ] Delete the audit database so the next drill passes.
Why: Any broken link in the tamper-evident audit hash chain is a Priority-1 security incident.
@@end
```

## 6. Execution Order for OpenCode

1. **Step 1 — Fix Deployment & Environment Wiring (`deploy/lib/hostPlanner.ts`, `deploy/lib/pkiManager.ts`, `deploy/provisioners/backupEngineProvisioner.ts`, `deploy/deploy.ts`):**
   - Implement Fixes 1 & 2 so `BACKUP_DAEMON_URL` and client certs are always injected into `core-back/.env`, certificate files in `BACKUP_DAEMON_CERT_DIR` are chowned to `backupDaemonUser(config)`, `SupplementaryGroups=postgres` is removed from the unit file, and `deployBackupDaemon()` uses `backupDaemonUser(config)` with `HOME=/var/lib/pg-backup`.
2. **Step 2 — Upgrade `deploy/backup-daemon/src/*` (`config.ts`, `server.ts`, `backupEngine.ts`, `restoreDrillRunner.ts`, `catalogStore.ts`):**
   - Implement Fixes 3, 4, & 5 (`node:https` mTLS server, `Idempotency-Key` + FIFO job mutex, `PUT /v1/wal/:target/:segment`, `pg-native` engine mode, fixed `WAL_ARCHIVE_STATUS_QUERY`, shared-cluster `audit_db` logical dump + drill support, `waitForRecoveryPromotion`, and PostgreSQL `JSONB::text` audit hash-chain verification).
3. **Step 3 — Update `core-back/api/internal/backups.ts`, `admin-back/api/protected/backups.ts`, & `deploy/test-matrix/gates.ts`:**
   - Implement Fix 6 (`walArchiveHealthy` field, `/catalog` proxy, and full drill completion polling in Gate 10).
4. **Step 4 — Implement the 4-Tier Automated Test Suite:**
   - Add `deploy/backup-daemon/test/cryptoEnvelope.test.ts` and `deploy/backup-daemon/test/live-pg18-pitr.test.ts`, and update existing unit/integration tests.
5. **Step 5 — Update Guide & Academy Content and Run Extractors:**
   - Add the new articles, cards, situations, lessons, and questions to `design/07-guides-and-academy/guide_system_design_and_content.md` and `design/07-guides-and-academy/academy_system_design_and_content.md`, then run `bun scripts/extract-guide-content.ts` and `bun scripts/extract-academy-content.ts` inside `admin-front/`.
6. **Step 6 — Run All Verification Commands:**
   - `cd deploy/backup-daemon && bun run typecheck && bun test`
   - `cd deploy && bun run typecheck && bun test`
   - `cd core-back && bun run typecheck && bun test test/backup-admin`
   - `cd admin-back && bun run typecheck && bun test test/backups.test.ts`
   - `cd admin-front && bun run content:guide && bun run content:academy && bun run test:unit && bun run type-check`
