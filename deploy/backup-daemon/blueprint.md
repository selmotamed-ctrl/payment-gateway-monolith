<!-- GENERATED FILE. Edit project-design/parts/** instead. Do not hand-edit this file. -->

# backup-daemon blueprint

Generated from: `deploy.backup`.

## Backup Daemon

> Status: `partial` · Last verified: 2026-11-03

## 1. Purpose and scope

`pg-backup-daemon` is the backup and point-in-time-recovery control plane for the storage tier. It wraps WAL-G or Barman, owns the full/delta/drill schedule, keeps a local catalog, exposes an mTLS HTTP API and runs scratch restore plus ledger/audit invariant drills.

It owns engine selection, scheduling, the catalog, the HTTP API, target/WAL health and drills. It does not own the PostgreSQL cluster, archive configuration (the provisioner does), the admin approval workflow (core does) or the admin UI.

## 2. Design intent (extracted and synthesized from ./design)

The design calls for a Bun service that supports WAL-G on the database host and Barman on a dedicated backup host, streams WAL with compression and client-side encryption, takes weekly full and daily delta backups for core and audit, snapshots Redis, mirrors to an optional secondary vault, and runs a weekly scratch restore that verifies double-entry zero drift, sharded balance parity and the audit hash chain before signing and cleaning up.

It exposes overview, trigger, policy, run and drill endpoints over mTLS to core, which surfaces them to the admin portal. Policy changes require core-side maker-checker. The historical design's Tripoli 03:00 and hourly Redis claims are superseded; the code uses UTC cron expressions and triggered Redis snapshots.

## 3. As-built architecture

### 3.1 Process lifecycle

`src/index.ts` loads and validates the environment, creates a `SpawnCommandRunner`, creates the WAL-G/Barman engine, loads the catalog (or falls back to memory), builds a default policy, creates the drill runner, scheduler and server, starts the scheduler when enabled, and logs the listener/engine/scheduler state. SIGTERM/SIGINT stops the scheduler and server, waits up to 15 seconds for in-flight work and exits.

### 3.2 HTTP server and mTLS

`src/server.ts` uses `Bun.serve` with a JSON handler:

| Method | Path | Purpose |
| :--- | :--- | :--- |
| GET | `/health` | Liveness, engine mode and version. Does not run engine health checks. |
| GET | `/v1/overview` | Engine health, WAL lag, targets, schedule/policy, scheduler state, recent backups and drills. |
| POST | `/v1/backups/trigger` | Validates `{ target, kind }`, queues a run and returns 202. |
| PUT | `/v1/policy` | Persists cron/retention/lag and returns the policy. |
| GET | `/v1/runs`, `/v1/drills` | Recent records with `limit` 1-500. |
| POST | `/v1/drills/run` | Queues a drill and returns 202. |

Bodies are capped at 256 KiB. Responses use `cache-control: no-store` and recursively redact credential-shaped keys/values. `HttpError` becomes a JSON envelope; unexpected errors become a generic 500 with a request id.

`loadTlsOptions()` returns plain HTTP only when `BACKUP_ALLOW_INSECURE_HTTP=true`. Otherwise it requires the server certificate, key and CA and sets `requestCert: true`, `rejectUnauthorized: true`. The daemon verifies the client chain but does not inspect the client CN; any CA-signed client can call every route. Core presents `backup-client`.

### 3.3 Engines

`createBackupEngine()` selects `WalGEngine` or `BarmanEngine`.

**WAL-G**:

- `triggerBackup("all", kind)` expands to `postgres_core`, `audit_db` and, when `REDIS_URL` is set, `redis`;
- refuses `audit_db` when `PG_AUDIT_DATA_DIR` is empty;
- runs `wal-g backup-push <dataDir>` for full, `--delta` for delta;
- verifies the bucket with `wal-g st ls <prefix>`;
- mirrors with `rclone sync` or `rsync -a --delete` when a secondary target exists;
- `prune("all","full")` runs `wal-g delete retain FULL <count> --confirm`; delta pruning is a no-op;
- lists with `wal-g backup-list --json`; `recover()` fetches the latest base backup and returns a recovery fragment;
- Redis backup runs `BGSAVE`, `redis-cli --rdb <tmp>` and `rclone copyto <tmp> <corePrefix>/redis/dump.rdb`, then removes the temp file.

Health checks the S3 target with `wal-g st ls`, PostgreSQL with `psql SELECT 1`, optional secondary/Redis, WAL lag from the first replica or primary, and archive lag/bytes from `pg_stat_archiver`. It is healthy when every target passes and archive lag is within `BACKUP_ALERT_LAG_SECONDS`.

**Barman**:

- `triggerBackup` expands `all` the same way (including audit), runs `barman check`, `barman backup`/`--incremental`, then `barman-cloud-backup`; it reports only `primary-s3`, with no secondary mirror;
- lists with `barman list-backup`; `recover()` picks the latest and runs `barman recover --target-time`; `prune()` is a no-op because Barman applies server-side retention.

Barman health runs `barman check` for core and audit, checks S3 with the **WAL-G** `st ls` command, checks PostgreSQL, and adds optional secondary/Redis. Barman health therefore requires WAL-G and does not prove Barman's cloud/retention path. This document does not claim complete Barman health.

### 3.4 Scheduler

`src/scheduler.ts` uses a strict five-field cron parser (no macros or seconds), computes the next full/delta/drill slots, ticks every `SCHEDULER_TICK_MS` (default 30 seconds), reloads policy from the catalog, skips a due job when another job is running, records runs as `QUEUED`/`RUNNING`/`PASSED`/`FAILED`, reserves unique ids, attempts a full prune after a successful full backup, and records signed drill reports. A policy update through `PUT /v1/policy` takes effect on the next tick without a restart.

### 3.5 Catalog

`src/catalogStore.ts` stores runs, drills and policy in one JSON file (`BACKUP_CATALOG_PATH`), writes atomically via temp file + rename, serializes writes, keeps at most 500 runs and 100 drills, validates on load, falls back to in-memory operation when unwritable or corrupt, and reports the persistence error. The catalog is not encrypted and is not backed up by the daemon.

### 3.6 Restore drill

`src/restoreDrillRunner.ts`:

1. Sets `targetTime = now - 5 minutes` and stops/removes prior scratch clusters.
2. Calls `engine.recover()` for `postgres_core` and `audit_db`.
3. Refuses `initdb` over a failed restore unless the engine explicitly reports an initialized empty directory.
4. Writes `recovery.conf` into `postgresql.auto.conf`, creates `recovery.signal`, and starts both clusters on the configured ports over loopback.
5. Runs the double-entry zero-drift query, the sharded-balance parity query and the audit hash-chain query.
6. Builds a report with status, duration, target time, replayed LSN, drift, mismatch counts, broken links and per-check details.
7. Signs it with HMAC-SHA256 using `BACKUP_ENCRYPTION_KEY_HEX`.
8. Stops and removes both scratch clusters in `finally`.

A failed restore, start or check still produces a signed `FAILED` report through the scheduler or HTTP path. The drill requires an audit recovery target; without an audit database or `PG_AUDIT_DATA_DIR`, the audit recovery fails and the drill fails.

### 3.7 Core and admin integration

`core-back/lib/storageEngine/backupControlClient.ts` builds a TLS 1.3 keep-alive agent with the internal CA and `backup-client` cert/key and calls overview/health/trigger/drill/policy/runs/drills.

`core-back/api/internal/backups.ts`:

- `GET /overview` requires `security:read` or `gateway:read`, fetches daemon health and upserts runs/drills with `Promise.allSettled`;
- `POST /trigger` and `POST /drill` require `security:write`, require a configured daemon, call it and insert a local queued row;
- `PUT /policy` requires `security:write`; without `approvalRequestId` it creates a `BACKUP_POLICY` approval (`PENDING_REVIEW`, 7-day expiry) and returns 202; with an id it checks subject type, state and maker != checker, sends the **approved payload** to the daemon, marks the approval `EXECUTED`, bumps the base version and writes an audit record;
- `GET /catalog` returns local runs/drills.

`admin-back/api/protected/backups.ts` applies `security:read`/`security:write` at the edge, forwards overview/trigger/drill/policy and relays core status. The daemon's own `PUT /v1/policy` has no maker-checker, so a direct mTLS client can bypass the core approval workflow.

### 3.8 Systemd and source deployment

`backupEngineProvisioner.ts` writes `/etc/systemd/system/pg-backup-daemon.service`: `User/Group=pgbackup`, `WorkingDirectory=/opt/pg-backup-daemon`, `EnvironmentFile=/etc/pg-backup/backup.env`, `ExecStart=/usr/local/bin/bun run src/index.ts`, `Restart=always`, `RestartSec=3`, `LimitNOFILE=65536`, `NoNewPrivileges=true`, `ProtectSystem=strict`, and `ReadWritePaths` for backup, log, catalog, cert, scratch and pgpass directories.

`deploy.ts` copies `deploy/backup-daemon` to `/opt/pg-backup-daemon` with rsync `--delete`, excludes `node_modules`, `.git`, `dist`, `test`, `*.log` and `.env`, chowns to `pgbackup`, runs `bun install --frozen-lockfile` as `pgbackup`, and enables/restarts the unit.

The provisioner writes `/etc/cron.d/pg-backup`: when the scheduler is enabled only a comment; otherwise full/delta trigger lines as `pgbackup` and the drill script as root. `/usr/local/bin/pg-backup-restore-drill` restores core and checks double-entry only; it is narrower than the in-process drill.

## 4. Contracts and invariants

- The daemon listens over mTLS by default and refuses plain HTTP unless explicitly allowed for development.
- Core presents a CA-signed `backup-client` certificate; the daemon does not authorize a CN per route.
- Trigger and drill return 202 and complete asynchronously; the catalog is the state store.
- Scheduled jobs do not overlap; HTTP triggers are not globally serialized.
- Catalog writes are atomic; a failed write does not crash the daemon.
- Secrets are redacted from responses and error messages.
- Full backups are followed by a best-effort prune; delta pruning is non-destructive.
- Audit backups require `PG_AUDIT_DATA_DIR`; the daemon never substitutes the core data directory.
- Drills restore core and audit, check three invariants, sign the report and always clean up scratch clusters.
- Policy changes through core require maker-checker; the daemon endpoint itself does not.

## 5. Data / API / config / deployment surface

| Group | Keys |
| :--- | :--- |
| Engine/encryption | `BACKUP_ENGINE_MODE`, `BACKUP_COMPRESSION`, `BACKUP_ENCRYPTION_KEY_HEX`, `BACKUP_ALLOW_INSECURE_HTTP`, `BACKUP_COMMAND_TIMEOUT_MS` |
| S3/secondary | `BACKUP_PRIMARY_S3_ENDPOINT`, `BACKUP_PRIMARY_S3_BUCKET`, `BACKUP_PRIMARY_S3_ACCESS_KEY`, `BACKUP_PRIMARY_S3_SECRET_KEY`, `BACKUP_CORE_S3_PREFIX`, `BACKUP_AUDIT_S3_PREFIX`, `BACKUP_SECONDARY_SSH_TARGET` |
| Schedule/retention | `BACKUP_FULL_CRON`, `BACKUP_DELTA_CRON`, `BACKUP_DRILL_CRON`, `BACKUP_RETENTION_FULL_COUNT`, `BACKUP_RETENTION_WAL_DAYS`, `BACKUP_ALERT_LAG_SECONDS`, `SCHEDULER_ENABLED`, `SCHEDULER_TICK_MS` |
| Listener/mTLS | `BACKUP_DAEMON_PORT`, `BACKUP_DAEMON_BIND_HOST`, `BACKUP_DAEMON_CERT_PATH`, `BACKUP_DAEMON_KEY_PATH`, `BACKUP_DAEMON_CA_CERT_PATH` |
| PostgreSQL | `PG_PRIMARY_HOST`, `PG_PRIMARY_PORT`, `PG_PRIMARY_USER`, `PG_PRIMARY_PASSWORD`, `PG_PRIMARY_DB_NAME`, `PG_AUDIT_DB_NAME`, `PG_REPLICA_NODES`, `PG_DATA_DIR`, `PG_AUDIT_DATA_DIR`, `PG_BIN_DIR` |
| Catalog/scratch | `BACKUP_CATALOG_PATH`, `BACKUP_SCRATCH_DIR`, `BACKUP_SCRATCH_PORT`, `BACKUP_SCRATCH_AUDIT_DIR`, `BACKUP_SCRATCH_AUDIT_PORT`, `PGPASSFILE` |
| Binaries | `WALG_BIN`, `BARMAN_BIN`, `BARMAN_CLOUD_BIN`, `BARMAN_SERVER`, `BARMAN_AUDIT_SERVER` |
| Redis | `REDIS_URL`, `REDIS_CLI_BIN` |

`BACKUP_ENCRYPTION_KEY_HEX` must be hex, at least 16 bytes and even length; the deploy requires exactly 64 hex characters. `backup.env.example` is a local/troubleshooting reference; a deployment generates `/etc/pg-backup/backup.env` from `deploy.env`.

## 6. Operational usage

```bash
cd deploy/backup-daemon
bun install
bun run start
bun test
bun run typecheck
```

On a deployed host, use `systemctl status pg-backup-daemon`, `journalctl -u pg-backup-daemon`, and a curl request with `internal-ca.crt`, `backup-client.crt` and `backup-client.key` to `/v1/overview`. Admin triggers and policy changes go through core; policy changes require a second user.

## 7. Status and deviations

### Implemented

- WAL-G/Barman full/delta backup, listing, restore, verification and cloud copy.
- Optional Redis snapshot.
- S3 primary and optional secondary mirror for WAL-G.
- In-process cron scheduler with policy reload and overlap skipping.
- Atomic JSON catalog with in-memory fallback.
- Core+audit drill with double-entry, balance parity and audit-chain checks and HMAC-signed reports.
- mTLS server with client-certificate verification and secret redaction.
- Core proxy/approval integration and admin edge routes.
- Provisioner-generated env, systemd unit, cron and source deployment.

### Partial

- Barman health depends on WAL-G for the S3 target.
- No per-CN daemon authorization.
- The shell drill is narrower than the in-process drill.
- The catalog is one unencrypted JSON file with count-based retention.

### Missing / deferred

- Log-database backup target.
- HTTP trigger serialization/backpressure.
- Automatic certificate/key ownership correction for `pgbackup`.
- Catalog backup and encryption.
- A verify-only restore mode.

### Known bugs / risks

- `all` includes `audit_db` without checking whether audit is configured; WAL-G needs `PG_AUDIT_DATA_DIR` and Barman needs an audit server.
- A Barman-only installation reports the primary S3 target unhealthy because health uses WAL-G.
- The backup cert/key may be root-owned and unreadable by `pgbackup`, preventing mTLS startup and failing the deploy probe.
- Any CA-signed certificate can call the policy endpoint directly and bypass maker-checker.
- Concurrent HTTP triggers are not serialized.
- The drill requires audit recovery even for a core-only intent.
- An interrupted cleanup can leave scratch clusters/directories.
- The catalog may contain host/run metadata and is not encrypted.

## 8. Verification and tests

```bash
cd deploy/backup-daemon && bun run typecheck && bun test
cd deploy && bun test test/provisioners.test.ts
```

Covered: WAL-G/Barman command builders and target routing; audit data-directory refusal; scheduler policy reload/overlap; catalog atomicity/corruption/retention; cron parsing; HTTP contract/validation/redaction; mTLS refusal of plain HTTP; drill success/failure, initdb guard, audit-chain verification and cleanup; provisioner env/unit/cron/scripts.

Not covered: a real WAL-G/Barman backup or restore; a real PostgreSQL 18 scratch drill; daemon startup as `pgbackup` with deployed cert ownership; Barman-only health; core maker-checker against the daemon.

## 9. Source references

### Old design sections

- `design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md` section 5.1 and 5.2.
- `design/payment_gateway_deployment_and_guides_architecture.md` section 6, deployment pipeline.

### Code paths

- `deploy/backup-daemon/src/index.ts`, `server.ts`, `backupEngine.ts`, `scheduler.ts`, `catalogStore.ts`, `restoreDrillRunner.ts`, `config.ts`.
- `deploy/provisioners/backupEngineProvisioner.ts`, `deploy/deploy.ts`.
- `core-back/lib/storageEngine/backupControlClient.ts`, `core-back/api/internal/backups.ts`.
- `admin-back/api/protected/backups.ts`.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/stale-claims-register.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.
