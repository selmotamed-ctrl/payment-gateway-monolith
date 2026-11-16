---
id: deploy.backup
title: Backup Daemon
status: partial
confidence: high
last_verified: 2026-11-12
verified_against: 1000189+working-tree
code:
  - deploy/backup-daemon/src/**
  - deploy/backup-daemon/backup.env.example
  - deploy/backup-daemon/README.md
  - deploy/provisioners/backupEngineProvisioner.ts
  - deploy/provisioners/postgres18Provisioner.ts
  - deploy/deploy.ts
  - deploy/lib/hostPlanner.ts
  - deploy/lib/pkiManager.ts
  - deploy/test-matrix/gates.ts
  - core-back/lib/storageEngine/backupControlClient.ts
  - core-back/api/internal/backups.ts
  - admin-back/api/protected/backups.ts
design_sources:
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#5-segment-4--backup-management-orchestrator--admin-control-plane-pg-backup-daemon--core-back--admin-front
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#52-core-back--admin-front-backup-management-api-contract
  - design/02-storage-and-performance/backup_engine_reliability_architecture_and_test_plan.md
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#6-ordered-14-step-multi-host-deployment-pipeline
tests:
  - deploy/backup-daemon/test/backupEngine.test.ts
  - deploy/backup-daemon/test/catalogMirror.test.ts
  - deploy/backup-daemon/test/catalogStore.test.ts
  - deploy/backup-daemon/test/commandRunner.test.ts
  - deploy/backup-daemon/test/config.test.ts
  - deploy/backup-daemon/test/cron.test.ts
  - deploy/backup-daemon/test/cryptoEnvelope.test.ts
  - deploy/backup-daemon/test/instanceLock.test.ts
  - deploy/backup-daemon/test/jobQueue.test.ts
  - deploy/backup-daemon/test/lab/two-host.lab.test.ts
  - deploy/backup-daemon/test/lab/single-host-deploy.lab.test.ts
  - deploy/backup-daemon/test/live-pg18-pitr.test.ts
  - deploy/backup-daemon/test/mtlsAuthorization.test.ts
  - deploy/backup-daemon/test/mtlsRoles.test.ts
  - deploy/backup-daemon/test/pgNativeEngine.test.ts
  - deploy/backup-daemon/test/restoreDrillRunner.test.ts
  - deploy/backup-daemon/test/scheduler.test.ts
  - deploy/backup-daemon/test/server.test.ts
  - deploy/backup-daemon/test/startup.test.ts
  - deploy/backup-daemon/test/storage.test.ts
  - deploy/backup-daemon/test/wal.test.ts
  - deploy/test/backupReliability.test.ts
  - deploy/test/provisioners.test.ts
  - core-back/test/backup-admin/backup-admin-routes.test.ts
  - core-back/test/backup-admin/backup-control-client.test.ts
  - admin-back/test/backups.test.ts
gaps:
  - The two-host lab passed for the pg-native engine on ONE pair of machines (Wi-Fi LAN, Ubuntu 26.04 backup host). WAL-G and Barman have never run live (they are retained as explicit, unexercised options), a multi-node/replica/PgBouncer topology was not exercised, and the labs are manual (not in CI).
  - The deploy engine's own execution of the pg-native provisioning (provisionPostgres18 + provisionAuditAndLogDb + provisionBackupEngine + deployBackupDaemon over ssh, then idempotency on a second pass) is covered by `test/lab/single-host-deploy.lab.test.ts`, which was written and type-checked but NOT run to completion: the target host became unreachable (the controlling machine changed network). Only string-level tests and the two-host lab (which uses the real generators) cover it until it is run.
  - The single-instance lock protects one state directory on one host; two daemons on different hosts sharing one S3 bucket are not detected and remain unsupported.
  - The native restore supports the default tablespace layout only; a cluster with extra tablespaces is refused at backup time (no unrestorable backup is ever produced) rather than restored.
  - Log-database backups are not a daemon target (ADR-0005); adding one needs target-enum, core API and admin UI changes.
---

# Backup Daemon

## 1. Purpose and scope

`pg-backup-daemon` is the backup and point-in-time-recovery (PITR) control plane for the storage tier. It takes full and incremental backups, archives WAL continuously, keeps an encrypted multi-tier repository, owns the full/delta/drill schedule, keeps a signed catalog, exposes an mTLS HTTP API and runs scratch-cluster restore drills that check the ledger and audit invariants.

It does not own the PostgreSQL cluster or its archive settings (the provisioner does), the admin approval workflow (core does) or the admin UI.

## 2. Design intent (extracted and synthesized from ./design)

The original design called for a Bun service wrapping WAL-G (same host) or Barman (separate host). `design/02-storage-and-performance/backup_engine_reliability_architecture_and_test_plan.md` (2026-11-06) added a root-cause audit and a topology-agnostic `pg-native` engine. It was implemented with the deviations in section 9.

## 3. As-built architecture

### 3.1 Process lifecycle

`src/index.ts` loads and validates the environment, builds the storage tiers (`buildRepository`), loads the catalog with an encrypted mirror (recovering from it on a fresh host), builds the engine with the live policy as retention source, rebuilds run history from manifests when no catalog exists, creates one shared `JobQueue`, the drill runner, the scheduler and the server, then starts the engine's background workers (WAL streaming, WAL mirroring) and the scheduler. On SIGTERM/SIGINT it stops the scheduler and server, waits up to 15 seconds for in-flight work, stops the workers and flushes the catalog mirror.

### 3.2 Engines

`createBackupEngine()` selects `PgNativeEngine`, `WalGEngine` or `BarmanEngine` from `BACKUP_ENGINE_MODE`.

| Engine | Where it runs | Needs |
| :--- | :--- | :--- |
| `pg-native` | same host or a dedicated backup host | PostgreSQL 18 client/server binaries, `zstd`, `tar`; S3 optional |
| `wal-g` | same host as the primary (reads `PGDATA`, peer auth as `postgres`) | `wal-g`, S3 |
| `barman` | dedicated backup host | `barman`, `barman-cloud-backup`, S3 |

**Cluster topology** (`config.ts`): `isAuditDedicatedCluster()` is true when `PG_AUDIT_DATA_DIR` is set or `PG_AUDIT_HOST` differs from `PG_PRIMARY_HOST`. `PG_AUDIT_PORT` is deliberately not used (it defaults to 5434 and would make every shared deployment look dedicated). `target=all` expands to `postgres_core`, `audit_db` (when an audit database is configured) and `redis` (when `REDIS_URL` is set). In a shared cluster `audit_db` is a logical dump plus signed manifest (skipped for `all` when the database is absent, an error for an explicit request); in a dedicated cluster it is a physical backup plus a dump. This applies to all three engines, so `PG_AUDIT_DATA_DIR is required` no longer occurs. `backupDaemonEnv()` leaves `PG_AUDIT_DATA_DIR` empty when the audit node resolves to the primary's own cluster (same SSH host and service port), so the shared-cluster logical-dump path is actually selected; a dedicated audit node or an explicit `PG_AUDIT_DATA_DIR` still selects the physical audit backup. On Arch-family hosts the daemon's `PG_BIN_DIR` (`/usr/lib/postgresql/<version>/bin`, a Debian layout) must resolve to the PostgreSQL tools; the single-box local setup aliases it to `/usr/bin`.

**pg-native backups**

- Tablespaces: a cluster with non-default tablespaces is refused before any backup is produced (and a produced backup containing anything but `base.tar`/`pg_wal.tar`/`backup_manifest` is refused), because the native restore would silently lose them.
- Full: `pg_basebackup --format=tar --wal-method=stream --checkpoint=fast --manifest-checksums=SHA256`, verified with `pg_verifybackup --format=tar --no-parse-wal` (tar verification cannot parse WAL), then `tar -> zstd -6 -> AES-256-GCM` into every tier. A logical `pg_dump --format=custom --compress=zstd:6` of the core and audit databases is stored with every full backup and checked with `pg_restore --list`.
- Delta: `pg_basebackup --incremental=<parent backup_manifest>` (PostgreSQL 17+). It requires `summarize_wal = on` and a previous verified backup and otherwise fails; it never silently becomes a full. The parent's `backup_manifest` is kept under `<catalog dir>/manifests/` and recovered from the parent artifact when local state is gone.
- The signed manifest is written last; a failed run deletes everything it wrote.
- Redis is dumped with `redis-cli --rdb` and stored encrypted in the repository.

**Continuous WAL** has two de-duplicated paths. `pg_receivewal --synchronous` runs supervised (restart with backoff, interruptible on stop) against a persistent slot (`PG_REPLICATION_SLOT`, created with `--if-not-exists`); finished segments are encrypted into the repository and leave the private 0700 spool, the `.partial` segment stays so a restore can use it. Independently the database's `archive_command` runs `curl --upload-file` to `PUT /v1/wal/:target/:file` over mTLS with the `wal-archive-client` certificate. Ingest is idempotent (same bytes acknowledged), refuses different bytes for an existing name with 409 (the archive is never overwritten) and is acknowledged once stored on the first tier; other tiers are mirrored asynchronously with retry and a periodic reconcile. A streamed segment that conflicts is quarantined under the spool `conflicts/` directory.

**Disaster recovery ("latest")**: `RecoverRequest.latest` (HTTP `POST /v1/drills/run {"latest": true}`, exclusive with `targetTime`) omits `recovery_target_*` so PostgreSQL replays every archived segment plus the streamed `.partial` one and promotes when the WAL runs out. It is supported by all three engines (Barman omits `--target-time`). It is how a lost primary is rehearsed from the backup host alone.

**Restore** picks the newest verified backup finished at or before the target time, resolves its chain to a full backup, fetches each artifact from the first tier whose copy matches the signed SHA-256 (a damaged local copy falls through to the next tier), decrypts and extracts it, runs `pg_combinebackup` for chains, extracts the newest backup's `pg_wal.tar`, and returns a recovery fragment whose `restore_command` is `bun src/walFetchCli.ts <target> %f %p`. `walFetchCli` reads the daemon environment (inherited by the scratch PostgreSQL), takes the WAL from the first tier that has it, decrypts it, and falls back to the streamed `.partial` file. `recovery_target_time` uses a numeric UTC offset because PostgreSQL rejects an ISO `Z` suffix while reading its configuration.

**Retention** (`prune`) follows the live maker-checker policy: whole backup chains older than `fullRetentionDays` are removed with their artifacts and dumps, the newest full backup and its deltas are never removed, WAL older than the first segment of the oldest retained full backup (and older than `walRetentionDays` on the local tier) is removed, timeline history files are kept, tampered manifests are ignored and never trigger deletes. WAL-G prunes `retain FULL ceil(days/7)` from the same policy; Barman keeps server-side retention.

**WAL-G and Barman** keep their command builders. WAL-G talks to PostgreSQL over the local socket as `postgres`; it is intentionally NOT pointed at `PG_PRIMARY_HOST`/`PG_PRIMARY_USER` (that is the application role, which cannot start a backup). Barman health runs `barman check` (audit only for a dedicated cluster) and proves the object store with the daemon's own S3 client; it never calls `wal-g`.

**Archive lag** only counts while archiving is genuinely behind: time since the last archive is reported when a COMPLETED segment is waiting (current segment > last archived + 1) or the archiver is failing (`last_failed_time` newer than `last_archived_time`); the segment currently being written is not late, so an idle database (no WAL) no longer alarms.

**WAL stream lag**: the `wal-stream-<target>` health target shows how far the stream is behind the primary, read from `pg_replication_slots.restart_lsn` (visible to every role, unlike `pg_stat_replication`), and is unhealthy above `BACKUP_STREAM_ALERT_BYTES` (default 256 MiB). A running stream that is a gigabyte behind is not protecting the data; `pg_stat_archiver` lag alone did not show that.

**Health** reports every storage tier (local repository, S3, off-site vault), the primary (and dedicated audit) cluster, Redis, `wal-stream-<target>` and a WAL mirror backlog, plus WAL lag from `pg_stat_archiver`. `last_archived_wal` is a segment file name; the byte lag is computed from segment numbers (`walNames.ts`) and the file name is never passed to `pg_wal_lsn_diff()`.

### 3.3 Storage tiers and encryption

`artifactStore.ts` defines three tiers behind one interface, addressed by relative keys (`backups/<target>/<id>.tar.zst.enc`, `wal/<target>/<segment>.zst.enc`, `logical/<db>/<id>.dump.enc`, `catalog/catalog.json.enc`): a local repository (atomic temp+rename), S3/MinIO/R2 through `Bun.S3Client` (SigV4), and an off-site vault (`rsync` with a remote `sha256sum` check, or `rclone`). The vault is append-only unless `BACKUP_SECONDARY_MIRROR_DELETE=true`. Local and S3 are required for a write to succeed; the vault is best effort. S3 is optional for `pg-native`.

`cryptoEnvelope.ts`: `"PGBKv2" | version | salt(16) | iv(12) | AES-256-GCM ciphertext | tag(16)`; payload key `HKDF-SHA256(master, salt, "pg-backup-v2:payload:<target>:<id>")`; the header and `<target>:<id>` are GCM additional data; compression precedes encryption; any modification fails closed and leaves no partial plaintext. Manifest times (`startedAt`/`completedAt`) come from the PRIMARY's `clock_timestamp()` (falling back to the local clock), because recovery targets are the primary's commit times and a dedicated backup host's clock can disagree. Manifests (`BackupManifest`, schema 2) record LSNs, WAL range, parent, sizes, SHA-256 of plaintext and ciphertext, encryption metadata, the `pg_verifybackup` result and tiers, and are HMAC-SHA256 signed under `HKDF(master, "pg-backup-v2-catalog", "manifest-hmac-sha256")`. A manifest that does not verify is ignored.

### 3.4 HTTP server, roles and job queue

`src/server.ts` serves JSON; bodies other than WAL are capped at 256 KiB, responses are `no-store` with recursive credential redaction.

| Method | Path | Role | Purpose |
| :--- | :--- | :--- | :--- |
| GET | `/health` | control | liveness, engine mode, version |
| GET | `/v1/overview` | control | health, WAL, targets, policy, scheduler, `jobs`, `walArchive`, recent runs/drills |
| POST | `/v1/backups/trigger` | control | `{ target, kind }` -> 202 `{ backupJobId, queuePosition }` |
| POST | `/v1/drills/run` | control | `{ requestedBy?, targetTime? }` -> 202 `{ drillId, queuePosition }` |
| PUT | `/v1/policy` | control | full policy object |
| GET | `/v1/runs`, `/v1/drills` | control | `limit` 1-500 |
| PUT | `/v1/wal/:target/:file` | wal | raw WAL body <= `BACKUP_WAL_PUSH_MAX_BYTES`; 200/409/413/400/501 |

**mTLS roles.** The public listener is a `node:tls` server (Bun's `node:https` has no `getPeerCertificate()`; verified on Bun 1.4) that verifies the client chain, classifies the certificate CN/DNS SAN and bridges the decrypted stream to a per-role inner Bun listener on a private unix socket (loopback port on win32): `BACKUP_ALLOWED_CLIENT_CNS` (default `backup-client`) -> `control` (every route except WAL upload); `BACKUP_WAL_CLIENT_CNS` (default `wal-archive-client`) -> `wal` (only WAL upload); anything else 403. No HTTP is parsed in the gateway. The `wal-archive-client` certificate lives on the database hosts, so a compromised database host can push WAL but cannot read the catalog, change the policy or trigger jobs. Plain HTTP exists only with `BACKUP_ALLOW_INSECURE_HTTP=true` (role `open`).

**Job queue** (`jobQueue.ts`): every backup and drill, HTTP or scheduled, runs through one FIFO queue, one job at a time; a scheduled slot that finds the queue busy is skipped with a warning; the queue holds 25 waiting jobs, beyond which a request gets 429 and a FAILED run row. `Idempotency-Key` (1-128 chars of `[A-Za-z0-9._:-]`) returns 202 with the original job id and `deduplicated: true`; keys are scoped per route, expire after 24 h and the dedupe check and enqueue are atomic.

**Restart behavior** (`startup.ts`, `instanceLock.ts`): keys are persisted to `<catalog dir>/idempotency-keys.json`. At boot, runs left `QUEUED`/`RUNNING` by the previous process are marked `FAILED` ("interrupted: the daemon restarted...") instead of staying `RUNNING` forever, and keys are restored only for jobs that really finished: an interrupted job's key is dropped, so a client retry starts a fresh job instead of being handed the id of one that died with the old process. A pid lock (`<catalog dir>/daemon.lock`) refuses a second daemon on the same state directory (a stale or recycled-pid lock is taken over); it does not detect a daemon on another host.

### 3.5 Scheduler, catalog and mirror

`scheduler.ts` is unchanged except that it enqueues through the shared queue. `catalogStore.ts` keeps runs, drills and policy in one atomically written JSON file and, when a mirror is configured, uploads an encrypted, HMAC-signed copy to every tier after each save (latest-wins, never blocks or breaks a write). With no local catalog the store recovers from the first tier whose copy decrypts and verifies; a tampered or wrong-key copy is ignored. `importRuns` merges history rebuilt from manifests.

### 3.6 Restore drill

`restoreDrillRunner.ts` (`targetTime` defaults to now - 5 minutes and may be supplied, never in the future):

1. Stops and clears scratch; recovers the core cluster (and the audit cluster only when dedicated).
2. Makes the data directory startable: a physical backup holds `PGDATA` only and Debian-style clusters keep `postgresql.conf`/`pg_hba.conf` outside it, so a minimal config is generated, sized from `pg_controldata` (hot standby refuses to start below the primary's `max_connections` and related settings).
3. Appends the recovery settings and forces archiving off (`archive_mode=off`, `archive_command=''`, no slot/standby names, `ssl=off`). The restored `postgresql.auto.conf` carries the production `archive_command`; without this a promoted scratch cluster pushed `00000002.history` and timeline-2 WAL into the production archive in the live test and every later restore failed.
4. Starts on loopback and waits for recovery to finish and promote (`pg_is_in_recovery() = f`, up to `BACKUP_RECOVERY_TIMEOUT_MS`); a failed start includes the server-log tail.
5. Runs three checks: double-entry zero drift, sharded balance parity, and the audit hash chain. Core queries run as `PG_PRIMARY_USER`; audit queries always run as `PG_AUDIT_USER` (the primary role when unset), because only the audit role is granted on the audit database and a dedicated audit cluster does not have the core application role.
6. Signs the report with HMAC-SHA256 and destroys the scratch cluster.

The audit chain accepts either canonical form: the database's own `before_json::text`/`after_json::text` with the timestamp formatted as the trigger formats it (what the trigger hashes), or the application's stable-JSON form; `seq_no` must be gap-free so a deleted row is detected. In a shared cluster a missing audit database is restored from the newest logical dump into the same scratch cluster.

### 3.7 Two-host lab

`deploy/backup-daemon/test/lab/two-host.lab.test.ts` (skipped unless `LAB_B_HOST`, `LAB_B_USER`, `LAB_B_PASSWORD` are set; credentials only from the environment; `LAB_KEEP=1` leaves host B provisioned) puts a throwaway primary on this machine (Debian-style config, TLS on, scram, `hostssl`-only for host B) and the daemon alone on a second machine as the `pg-backup-daemon` systemd service running as `pgbackup`, with no PostgreSQL server running there. The backup env, the systemd unit, the `archive_command` and the cluster SQL are rendered by the REAL provisioner functions; the only substitution is host A's certificate directory (no root on A). It also runs the deploy engine's `bunInstallCommand` and opens the daemon port in the host's ufw to host A alone, as the deploy firewall policy does. Verified: B is a dedicated backup host (no PostgreSQL server, nothing on 5432, daemon user `pgbackup`); mTLS across the LAN with `wal-archive-client` limited to WAL; full backup over `hostssl` + scram with `pg_dump` as the least-privilege audit role; WAL by both paths; delta; 24 restore drills on B in 41 s while the primary held 3,005 tps / 0.08 ms before and 2,995 tps / 0.09 ms during; and host A total loss (`kill -9`, data deleted) recovered from B alone: 128 of 128 ledger lines including commits never archived, 84 audit rows, drift 0.0000.

### 3.8 Core, edge and deploy integration

`core-back` forwards a well-formed `Idempotency-Key` to the daemon and returns `deduplicated` without a new local row; `GET /overview` adds `walArchiveHealthy` (daemon healthy and archive lag within the policy alert threshold). `admin-back` relays the key and exposes `GET /system/backups/catalog`. `hostPlanner.backupCoreEnv()` injects `BACKUP_DAEMON_URL`, cert paths and `BACKUP_DAEMON_TIMEOUT_MS` into core whenever `BACKUP_ENABLED`, independent of `pgStorageConfigured`.

`backupEngineProvisioner.ts` writes `backup.env`, the unit and (pg-native) the DB-host settings (`archive_mode=on`, `archive_command` via curl, `archive_timeout=60s`, `summarize_wal=on`, the replication role); it installs the PostgreSQL client and server binaries on the backup host and masks the default `postgresql` service on a host that runs no managed cluster. `backupDaemonUser()` is `postgres` only for wal-g co-located with the primary, otherwise `pgbackup`. The unit has no `SupplementaryGroups`, sets `HOME` and `BUN_INSTALL_CACHE_DIR` under `/var/lib/pg-backup` and includes the local repository in `ReadWritePaths`. The cron drill fallback (`pg-backup-restore-drill`, used only when the daemon scheduler is disabled) asks the daemon for a drill for EVERY engine; the former root shell script (latest base backup, no WAL replay, double-entry only) is gone. `deploy.ts` chowns the daemon certificate directory to the daemon user, installs `wal-archive-client` and the CA in `/etc/pg-deploy/certs` on PostgreSQL hosts (key group-readable by `postgres`), runs `bun install` as the daemon user and waits up to 10 s for the unit to stay active, printing `journalctl` and exiting 1 on failure. `pkiManager` issues `wal-archive-client` (CN `wal-archive-client`) and distributes it only to `pg-primary` and `audit-db` hosts.

## 4. Contracts and invariants

- The daemon listens over mTLS by default and refuses plain HTTP unless explicitly allowed.
- Control routes require a `backup-client` CN; WAL upload requires a `wal-archive-client` CN and nothing else; the lists must be disjoint.
- Backups, drills and scheduled slots never overlap; trigger and drill return 202 and complete asynchronously; the catalog is the state store.
- A stored WAL file is never overwritten; a backup does not exist until its signed manifest does.
- Every artifact is authenticated-encrypted; a tampered manifest, ciphertext or catalog copy fails closed.
- A drill never writes into the production archive and always destroys its scratch cluster.
- Secrets are redacted from responses and error text; passwords travel only in child environments.
- Retention follows the live policy and never removes the newest full backup.

## 5. Data / API / config / deployment surface

See `deploy/backup-daemon/README.md` section 7 for the full key table. Additions in this change: `BACKUP_ENGINE_MODE=pg-native`; `BACKUP_LOCAL_REPO_DIR`, `BACKUP_WAL_SPOOL_DIR`, `BACKUP_STAGING_DIR`, `BACKUP_WAL_CLIENT_CNS`, `BACKUP_WAL_PUSH_MAX_BYTES`, `BACKUP_WAL_STREAMING_ENABLED`, `BACKUP_RECOVERY_TIMEOUT_MS`; `PG_AUDIT_HOST/_USER/_PASSWORD`, `PG_LOG_DB_NAME`, `PG_REPLICATION_USER/_PASSWORD`, `PG_REPLICATION_SLOT`, `PG_AUDIT_REPLICATION_SLOT`, `PG_SSLMODE`. `BACKUP_PRIMARY_S3_ENDPOINT/_BUCKET` are optional for `pg-native` and required for the others. Deploy-side keys: `BACKUP_LOCAL_REPO_DIR`, `BACKUP_WAL_CLIENT_CNS`, `BACKUP_DAEMON_TIMEOUT_MS`.

## 6. Operational usage

```bash
cd deploy/backup-daemon && bun install && bun run typecheck && bun test
```

On a deployed host use `systemctl status pg-backup-daemon`, `journalctl -u pg-backup-daemon` and a `curl` with `internal-ca.crt`, `backup-client.crt` and `backup-client.key`. Admin triggers and policy changes go through core; policy changes require a second user. A manual drill accepts `targetTime` directly on the daemon.

## 6a. Engine default (ADR-0004)

`BACKUP_ENGINE_MODE` defaults to `pg-native` and `auto` means `pg-native`; `wal-g` and `barman` must be chosen explicitly and keep their rules (wal-g only on the primary's host). S3 is optional for pg-native and required for the others. See `DECISIONS.md` ADR-0004 for the evidence and the consequences.

## 7. Status and deviations

### Implemented

- pg-native full/delta/logical backups, signed manifests, three-tier storage, chain restore, live-policy retention, continuous WAL (mTLS push + `pg_receivewal`), job queue and idempotency, per-role mTLS, catalog mirror and recovery.
- WAL-G/Barman fixes (shared audit, Barman health, archive status query, policy retention) and the drill fixes (JSONB-text audit hashes, gap check, shared cluster, config bootstrap, archive neutralization, promotion wait, target time).
- Deploy wiring fixes and gate 10 completion polling.

### Partial

- The deploy engine's SSH execution of the pg-native provisioning has not been run end to end against a host (see the gaps).

### Missing / deferred

- Log-database backup target, a verify-only restore mode, multi-tablespace restore (refused at backup time).

### Resolved by the two-host lab (same day)

- Host-loss recovery with zero loss of committed data ("latest" mode), restore drills not stalling the primary, and the dedicated-host provisioning path on a real systemd host; WAL stream lag now visible in health; manifest times independent of the backup host's clock; the daemon no longer logs a client disconnect as an unhandled failure.

### Resolved after the first implementation pass (same day)

- Idle-database false lag alarms; idempotency keys lost on restart and runs stuck `RUNNING` after a crash; second daemon on one state directory; unrestorable backups of clusters with extra tablespaces; the narrow root shell drill; drill role mapping for audit queries (dedicated and shared); the reserved `pg_audit_writer`/`pg_log_writer` default role names; least-privilege audit dump.

## 8. Verification and tests

```bash
cd deploy/backup-daemon && bun run typecheck && bun test
cd deploy && bun run typecheck && bun test
cd core-back && bun test test/backup-admin      # DB-backed: needs a private PostgreSQL
cd admin-back && bun test test/backups.test.ts
```

`live-pg18-pitr.test.ts` runs a private throwaway PostgreSQL under `/tmp` (Debian-style external config, `ALTER SYSTEM` archive settings, `max_connections=150`) with the real daemon over mTLS, `curl` as `archive_command` and real `pg_receivewal`. It covers: full backup with logical dumps, ciphertext and manifest checks, PITR to a point before an injected operator error (the error is excluded, 64 journal lines recovered), a full+delta chain restored through `pg_combinebackup`, the production archive staying free of timeline-2 files, a double-entry drift, a shard drift, a tampered audit row and a deleted audit row each failing exactly the right check, and a one-byte corrupted local copy surviving through the S3 copy while corrupting both fails at the integrity gate. A negative control (archive safety removed) makes it fail as expected. It skips when the PostgreSQL 17+ binaries, `zstd`, `curl`, `tar` or `openssl` are missing.

The live test also runs the audit database as the deployment's least-privilege role (`PG_AUDIT_USER`, SELECT/INSERT on `audit_records` only) for both the logical dump and the drill's chain check, and asserts that role cannot read the ledger or delete audit rows.

Not covered: the dedicated-backup-host and host-loss topologies on real machines, a dedicated audit cluster drill live (unit-tested), S3 against a real MinIO (a fake `S3ClientLike` and `Bun.S3Client` contract only), the off-site vault against a real SSH host.

## 9. Deviations from the 2026-11-06 reliability design

| Design claim | What was found and done |
| :--- | :--- |
| RC-05: the node:tls to unix-socket bridge drops frames | Not reproduced: 50 sequential and 50 concurrent keep-alive TLS 1.3 requests plus a POST passed on Linux. The bridge is kept. |
| Fix 3: use `node:https` and `req.socket.getPeerCertificate()` | `getPeerCertificate` is `undefined` on Bun 1.4's `node:https`. Authorization is done by classifying the certificate in the `node:tls` front and bridging to per-role inner listeners. |
| `pg_verifybackup` on tar backups | Requires `--no-parse-wal`; the drill proves the WAL. |
| `isAuditDedicatedCluster` includes `PG_AUDIT_PORT !== PG_PRIMARY_PORT` | The port defaults to 5434, so every shared deployment would look dedicated; the port is excluded. |
| `walGEnvironment` should use `PG_PRIMARY_HOST`/`PG_PRIMARY_USER` | Rejected: that is the application role and cannot start a backup; WAL-G runs as `postgres` on the local socket. |
| DB hosts push WAL with `pg-client` or `backup-client` | A dedicated `wal-archive-client` certificate is used. `pg-client`'s key also lives on core hosts and `backup-client` has full control-plane authority. |
| `recovery_target_time` as ISO with `Z` | PostgreSQL rejects it at startup; a numeric UTC offset is used (also fixes WAL-G's recovery config). |
| (not in the design) scratch cluster inherits `archive_command` | Archiving is forced off in every scratch cluster. |
| (not in the design) restored `PGDATA` has no configuration on Debian layouts | A minimal config sized from `pg_controldata` is generated. |
| Fix 6: academy question ids `q-m10-004..008` | They collided with existing questions; new ids continue the sequence. |
| (not in the design) default PostgreSQL role names | `PG_DB_USER` (`pg_core_user`) and `PG_REPLICATION_USER` (`pg_replicator`) defaulted to reserved `pg_*` names too, found when the lab rendered the real provisioner SQL. Defaults are now `gw_core_user`/`gw_replicator`, every role setting rejects `pg_*`, and test fixtures that used `pg_owner`/`pg_authoritative_user` were renamed. |
| (not in the design) `bunInstallCommand` symlinked bun into a home directory | The lab's first real run failed with `status=203/EXEC`: `/usr/local/bin/bun` was a symlink into `/home/<user>/.bun` (home is 0750), unreadable by the service user. The command now installs a real copy atomically and converts an existing symlink. |
| (not in the design) default audit/log role names | `AUDIT_DB_USER`/`LOG_DB_USER` defaulted to `pg_audit_writer`/`pg_log_writer`; PostgreSQL reserves `pg_*` so `CREATE ROLE` always failed. Defaults are now `gw_audit_writer`/`gw_log_writer` and `pg_*` is rejected at config load. |
| `BACKUP_ENGINE_MODE` default becomes `pg-native` | Adopted on 2026-11-06 (ADR-0004), after the single-host live test and the two-host lab. It was first left unchanged: `auto` keeps wal-g/barman until the two-host lab has run pg-native. |
| RC-03 root cause | Narrower than claimed: a full run re-chowned the certificate directory later in the storage step; it affected partial and rotate-only runs. |
| RC-07 `go install @latest` | Already a pinned version; only the lab's all-zero `BACKUP_WALG_SHA256` fallback was a defect. |
| Design 5.1/5.2 "5-gate" drill | The drill has three invariant checks; guide and academy content say so. |

## 10. Source references

### Old design sections

- `design/02-storage-and-performance/backup_engine_reliability_architecture_and_test_plan.md`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` sections 5.1 and 5.2.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 6.

### Code paths

- `deploy/backup-daemon/src/`: `index.ts`, `server.ts`, `jobQueue.ts`, `backupEngine.ts`, `pgNativeEngine.ts`, `pgTools.ts`, `walArchive.ts`, `walNames.ts`, `walFetchCli.ts`, `logicalDump.ts`, `artifactStore.ts`, `repository.ts`, `cryptoEnvelope.ts`, `catalogStore.ts`, `catalogMirror.ts`, `restoreDrillRunner.ts`, `scheduler.ts`, `config.ts`, `util.ts`.
- `deploy/provisioners/backupEngineProvisioner.ts`, `deploy/provisioners/postgres18Provisioner.ts`, `deploy/deploy.ts`, `deploy/lib/hostPlanner.ts`, `deploy/lib/pkiManager.ts`, `deploy/test-matrix/gates.ts`.
- `core-back/lib/storageEngine/backupControlClient.ts`, `core-back/api/internal/backups.ts`, `admin-back/api/protected/backups.ts`.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/stale-claims-register.md`

## 11. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.
- 2026-11-05: mTLS per-CN authorization, WAL-G env files, mirror delete opt-in.
- 2026-11-06: two-host lab pass: "latest" recovery, primary-clock manifests, stream lag health, `AbortError` handling, reserved default role names (`PG_DB_USER`, `PG_REPLICATION_USER`), real-copy bun install, the lab itself.
- 2026-11-06: gap-closure pass: idle lag, restart state and instance lock, tablespace guard, drill role mapping, cron fallback drill, reserved default role names, least-privilege live coverage.
- 2026-11-06: backup engine reliability implementation (previous revision): pg-native engine, three-tier encrypted repository, signed manifests and catalog mirror, WAL ingest over mTLS plus streaming, shared job queue and idempotency, per-role mTLS, topology-aware audit handling, drill fixes, deploy wiring fixes; section 9 lists where the design was corrected.

## Object storage parity, escrow and drill

`deploy/backup-daemon/src/objectStorageBackup.ts` copies new HOT/COLD
`.v1.enc` blobs into `object-blobs/{bucket}/{storageKey}` (immutable, so the
copy is incremental), fails with `OBJECT_STORAGE_BACKUP_PARITY_ERROR` when an
ACTIVE row has no blob on every required tier, repairs missing tier copies, and writes per-KEK-version escrows plus the legacy `object-storage/kek-escrow.enc` (AES-256-GCM
under the backup master key). The restore drill samples up to
`OBJECT_STORAGE_DRILL_SAMPLE` ACTIVE rows, decrypts them with the escrowed
keyring and compares the SHA-256; the report's `checks.objectStorage` carries the
result; the drill tries every tier and the escrow for the row's KEK version. The daemon receives the object-storage URL/client certs/KEK keyring from
the deploy engine.
