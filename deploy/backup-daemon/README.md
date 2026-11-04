# pg-backup-daemon

Backup and point-in-time-recovery control plane for the PostgreSQL 18 storage
tier. It wraps WAL-G or Barman, owns the full/delta/drill schedule, keeps a local
catalog, exposes an mTLS HTTP API, and runs scratch restore plus ledger/audit
invariant drills.

It is not a PostgreSQL provisioner and it is not the approval workflow. The
deploy engine configures the cluster and archive commands; `core-back` owns the
admin-facing proxy and maker-checker policy changes.

## 1. Architecture

```text
/etc/pg-backup/backup.env
          |
          v
   config.ts (Zod) --> commandRunner.ts (spawn, timeout, redaction)
          |                         |
          |                         +--> backupEngine.ts (WAL-G / Barman)
          |                         +--> restoreDrillRunner.ts
          v
   catalogStore.ts <---- scheduler.ts (full / delta / drill)
          |
          v
   server.ts (Bun.serve, mTLS) <---- core-back / operators
```

Startup (`src/index.ts`):

1. Load and validate the environment.
2. Create a `SpawnCommandRunner` with `BACKUP_COMMAND_TIMEOUT_MS`.
3. Create the WAL-G or Barman engine.
4. Load the JSON catalog, falling back to in-memory operation if it is
   unwritable or corrupt.
5. Build the default policy from the cron/retention/alert environment.
6. Create the drill runner, scheduler and HTTP server.
7. Start the scheduler when `SCHEDULER_ENABLED=true`.
8. Log the listener, engine and scheduler state.
9. On `SIGTERM`/`SIGINT`, stop the scheduler and server, wait up to 15 seconds
   for in-flight work and exit.

## 2. Engines

`createBackupEngine()` selects `WalGEngine` or `BarmanEngine` from
`BACKUP_ENGINE_MODE`.

### WAL-G

Targets: `postgres_core`, `audit_db`, `redis`. Kinds: `full`, `delta`.

- `target=all` expands to core plus audit, and also Redis when `REDIS_URL` is
  set.
- An `audit_db` target requires `PG_AUDIT_DATA_DIR`; the daemon refuses to
  substitute the core data directory.
- Full uses `wal-g backup-push <dataDir>`; delta adds `--delta`.
- After a PostgreSQL backup it verifies the prefix with `wal-g st ls`.
- A secondary target is mirrored with `rclone sync` (S3/rclone destination) or
  `rsync -a --delete` (SSH path).
- `prune("all","full")` runs `wal-g delete retain FULL <count> --confirm` for
  core and audit. Delta pruning is a no-op.
- `listBackups()` parses `wal-g backup-list --json`.
- `recover()` fetches the latest base backup and returns a recovery fragment
  containing `restore_command` and `recovery_target_time`.
- Redis runs `BGSAVE`, `redis-cli --rdb <tmp>`, then
  `rclone copyto <tmp> <corePrefix>/redis/dump.rdb` and removes the temp file.

WAL-G health checks the S3 prefix, PostgreSQL (`SELECT 1`), optional secondary
and Redis targets, WAL lag (from the first `PG_REPLICA_NODES` entry when set,
otherwise the primary), and archive lag/bytes from `pg_stat_archiver`. It is
healthy when every target passes and archive lag is within
`BACKUP_ALERT_LAG_SECONDS`.

### Barman

- `target=all` expands the same way, including audit and optional Redis.
- Runs `barman check`, `barman backup` or `--incremental`, then
  `barman-cloud-backup`.
- Reports only `primary-s3`; there is no secondary mirror in Barman mode.
- Lists with `barman list-backup`.
- `recover()` picks the latest backup and runs `barman recover --target-time`.
- `prune()` is a no-op because Barman applies server-side retention.

Barman health runs `barman check` for core and audit, checks the S3 target with
the **WAL-G** `st ls` command, checks PostgreSQL, and adds optional secondary and
Redis targets. Barman-only installations therefore need WAL-G installed for the
health probe and still do not fully validate Barman's cloud/retention path.

## 3. Scheduler

`src/scheduler.ts` uses a strict five-field cron parser: no macros and no
seconds field.

- Jobs: `full`, `delta`, `drill`.
- Tick cadence: `SCHEDULER_TICK_MS` (default 30 seconds).
- The policy is re-read from the catalog on every tick; a `PUT /v1/policy`
  change takes effect without a restart.
- A due job is skipped when another scheduled job is running.
- Runs are recorded as `QUEUED`, `RUNNING`, `PASSED` or `FAILED`.
- A successful full backup triggers a best-effort prune.
- A drill is recorded with a signed report.
- Scheduled backups always use `target=all`.

HTTP-triggered backups are not globally serialized with each other or with the
scheduler; only the scheduler refuses to overlap its own jobs.

## 4. HTTP API

`src/server.ts` uses `Bun.serve` with a JSON handler.

| Method | Path | Request | Response |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | - | Liveness, engine mode and version. Does not run engine health checks. |
| `GET` | `/v1/overview` | - | Engine health, WAL lag, targets, policy/schedule, scheduler state, recent runs and drills. |
| `POST` | `/v1/backups/trigger` | `{ "target": "all" \| "postgres_core" \| "audit_db" \| "redis", "kind": "full" \| "delta", "requestedBy"?: string }` | `202` with `backupJobId`, `acceptedAt`; work continues asynchronously. |
| `PUT` | `/v1/policy` | Full policy object: `fullCron`, `deltaCron`, `drillCron`, `fullRetentionDays`, `walRetentionDays`, `alertLagSeconds`, optional `updatedBy` | Updated policy. This is a full object, not a patch. |
| `GET` | `/v1/runs?limit=` | `limit` 1-500 | Recent backup runs. |
| `POST` | `/v1/drills/run` | Optional `{ "requestedBy"?: string }` | `202` with `drillId`, `acceptedAt`; work continues asynchronously. |
| `GET` | `/v1/drills?limit=` | `limit` 1-500 | Recent drill reports. |

Bodies are capped at 256 KiB. Responses use `cache-control: no-store`,
`x-request-id` and recursive credential redaction. Errors use
`{ error: { code, message, requestId } }`.

`PUT /v1/policy` itself has no maker-checker. The core proxy adds approval
semantics, but any CA-signed client that can reach the daemon can call the
daemon endpoint directly.

## 5. mTLS

`loadTlsOptions()`:

- returns plain HTTP only when `BACKUP_ALLOW_INSECURE_HTTP=true`;
- otherwise requires `BACKUP_DAEMON_CERT_PATH`, `BACKUP_DAEMON_KEY_PATH` and
  `BACKUP_DAEMON_CA_CERT_PATH`;
- sets `requestCert: true` and `rejectUnauthorized: true`.

The daemon verifies that a client certificate chains to the configured CA but
does not inspect the client CN. Any CA-signed client can call every route. Core
presents the `backup-client` certificate.

Certificate/key pairing is validated at config load: the cert and key must be
provided together, and a CA requires both.

## 6. Catalog

`src/catalogStore.ts` keeps runs, drills and policy in one JSON file
(`BACKUP_CATALOG_PATH`).

- Writes are serialized and atomic (temp file plus rename).
- It keeps at most 500 runs and 100 drills.
- A missing file is created on first use.
- A corrupt or unwritable file is replaced in memory and reported; the daemon
  keeps running without persistence.
- The catalog is not encrypted and is not backed up by the daemon.
- `fullRetentionDays` is stored in the policy; WAL-G pruning still uses
  `BACKUP_RETENTION_FULL_COUNT` from the environment.

## 7. Restore drill

`src/restoreDrillRunner.ts`:

1. Sets `targetTime = now - 5 minutes`.
2. Stops prior scratch clusters and removes/creates the scratch directories.
3. Calls `engine.recover()` for `postgres_core` and `audit_db`.
4. Refuses `initdb` over a failed restore unless the engine explicitly reports
   an initialized empty directory.
5. Writes `recovery.conf` content into `postgresql.auto.conf` and creates
   `recovery.signal`.
6. Starts both clusters on loopback with `pg_ctl` at the configured scratch
   ports.
7. Runs:
   - double-entry zero drift on `journal_lines`;
   - sharded balance parity on `gl_accounts`/`gl_account_shards`;
   - the audit hash chain on `audit_records`.
8. Builds a report with status, duration, target time, replayed LSN, drift,
   mismatch counts, broken links and per-check details.
9. Signs the report with HMAC-SHA256 using `BACKUP_ENCRYPTION_KEY_HEX`.
10. Stops and removes both scratch clusters in `finally`.

A failed restore, start or check still produces a signed `FAILED` report when it
goes through the scheduler or HTTP path. The drill requires an audit recovery
target; without an audit database/`PG_AUDIT_DATA_DIR` (WAL-G) or audit Barman
server, the drill fails.

The provisioner also installs `/usr/local/bin/pg-backup-restore-drill`, a
narrower shell drill that restores core and checks the double-entry invariant
only.

## 8. Environment contract

`src/config.ts` is the source of truth. Unknown environment keys are ignored.

### Engine, encryption and commands

| Key | Required | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `BACKUP_ENGINE_MODE` | yes | - | `wal-g` or `barman`. |
| `BACKUP_COMPRESSION` | no | `zstd` | `zstd`, `lz4`, `lzma`, `brotli` or `none`. |
| `BACKUP_ENCRYPTION_KEY_HEX` | yes | - | Hex, at least 16 bytes, even length; used for encryption and drill-report signing. The deploy schema requires exactly 64 hex characters. |
| `BACKUP_PRIMARY_S3_ENDPOINT` | yes | - | Absolute URL for S3/MinIO/R2. |
| `BACKUP_PRIMARY_S3_BUCKET` | yes | - | Bucket/prefix, for example `s3://payment-gateway-backups/prod`. |
| `BACKUP_PRIMARY_S3_ACCESS_KEY` | no | empty | Must be paired with the secret key. |
| `BACKUP_PRIMARY_S3_SECRET_KEY` | no | empty | Must be paired with the access key. |
| `BACKUP_CORE_S3_PREFIX` | no | `<bucket>/postgres_core` | WAL-G prefix for the core database. |
| `BACKUP_AUDIT_S3_PREFIX` | no | `<bucket>/audit_db` | WAL-G prefix for the audit database. |
| `BACKUP_SECONDARY_SSH_TARGET` | no | empty | Optional secondary vault (`user@host:/path`, `s3://...` or `rclone:` target). |
| `BACKUP_COMMAND_TIMEOUT_MS` | no | `1800000` | Timeout for a WAL-G/Barman/pg command. |
| `BACKUP_ALLOW_INSECURE_HTTP` | no | `false` | Development-only plain HTTP listener. |

### Schedule, retention and alerts

| Key | Required | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `BACKUP_FULL_CRON` | no | `0 2 * * 0` | Five-field full-backup cron. |
| `BACKUP_DELTA_CRON` | no | `0 2 * * 1-6` | Five-field delta-backup cron. |
| `BACKUP_DRILL_CRON` | no | `0 4 * * 0` | Five-field restore/invariant drill cron. |
| `BACKUP_RETENTION_FULL_COUNT` | no | `8` | Full backups retained by WAL-G prune. |
| `BACKUP_RETENTION_WAL_DAYS` | no | `14` | WAL retention in the default policy and provisioned Barman retention. |
| `BACKUP_ALERT_LAG_SECONDS` | no | `300` | Archive lag that marks the daemon unhealthy. |
| `SCHEDULER_ENABLED` | no | `true` | Run the in-process scheduler. |
| `SCHEDULER_TICK_MS` | no | `30000` | Scheduler evaluation cadence. |

### Listener and mTLS

| Key | Required | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `BACKUP_DAEMON_PORT` | no | `4090` | Control-plane listener. |
| `BACKUP_DAEMON_BIND_HOST` | no | `127.0.0.1` | Listener bind address. |
| `BACKUP_DAEMON_CERT_PATH` | conditional | - | Server certificate; required with the key unless insecure HTTP is allowed. |
| `BACKUP_DAEMON_KEY_PATH` | conditional | - | Server private key; paired with the certificate. |
| `BACKUP_DAEMON_CA_CERT_PATH` | conditional | - | Client CA; required for mTLS. |

### PostgreSQL 18 connection and paths

| Key | Required | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `PG_PRIMARY_HOST` | no | `127.0.0.1` | Primary host. |
| `PG_PRIMARY_PORT` | no | `5432` | Primary port. |
| `PG_PRIMARY_USER` | no | `postgres` | Backup/restore role. |
| `PG_PRIMARY_PASSWORD` | no | empty | Role password, exported as `PGPASSWORD` to `psql`. |
| `PG_PRIMARY_DB_NAME` | no | `payment_gateway_prod` | Core database. |
| `PG_AUDIT_DB_NAME` | no | `pg_audit_db` | Audit database. |
| `PG_REPLICA_NODES` | no | empty | Comma-separated `nodeId@sshHost:sshPort:privateIp:servicePort`, `host:port` or `host`. The first entry is used for WAL-lag health. |
| `PG_DATA_DIR` | no | `/var/lib/postgresql/18/main` | Core data directory used by WAL-G. |
| `PG_AUDIT_DATA_DIR` | no | - | Audit data directory; required for the WAL-G audit target. |
| `PG_BIN_DIR` | no | `/usr/lib/postgresql/18/bin` | `pg_ctl`, `initdb`, `psql`. |
| `WALG_BIN` | no | `wal-g` | WAL-G binary. |
| `BARMAN_BIN` | no | `barman` | Barman binary. |
| `BARMAN_CLOUD_BIN` | no | `barman-cloud-backup` | Barman Cloud binary. |
| `BARMAN_SERVER` | no | primary host | Barman server name for core. The deploy sets it to `PG_DB_NAME`. |
| `BARMAN_AUDIT_SERVER` | no | `PG_AUDIT_DB_NAME` | Barman server name for audit. The deploy sets it from `BARMAN_AUDIT_SERVER` or `AUDIT_DB_NAME`. |

### Catalog, scratch and Redis

| Key | Required | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `BACKUP_CATALOG_PATH` | no | `/var/lib/pg-backup/catalog.json` | Run/drill/policy catalog. |
| `BACKUP_SCRATCH_DIR` | no | `/var/lib/pg-backup/scratch` | Core scratch restore directory. |
| `BACKUP_SCRATCH_PORT` | no | `55432` | Core scratch PostgreSQL port. |
| `BACKUP_SCRATCH_AUDIT_DIR` | no | `<scratch>/audit` | Audit scratch restore directory. |
| `BACKUP_SCRATCH_AUDIT_PORT` | no | `55433` | Audit scratch PostgreSQL port. |
| `REDIS_URL` | no | - | Enables Redis snapshots and the `redis` target. |
| `REDIS_CLI_BIN` | no | `redis-cli` | Redis CLI binary. |

Boolean values accept `true`, `1`, `yes`, `on` (case-insensitive); any other
string is false. Cron fields are strictly five fields; `@daily` and second-based
expressions are rejected.

## 9. Deploy-generated environment

In a deployment, do not copy `backup.env.example` manually.
`deploy/provisioners/backupEngineProvisioner.ts` writes
`/etc/pg-backup/backup.env` from `deploy/deploy.env` and
`deploy/deploy.ts` syncs `deploy/backup-daemon` to `/opt/pg-backup-daemon`.

The generated file includes:

- engine, compression, encryption, S3 endpoint/bucket/keys and prefixes;
- `BARMAN_SERVER` set to `PG_DB_NAME` and `BARMAN_AUDIT_SERVER` set to
  `BARMAN_AUDIT_SERVER` or `AUDIT_DB_NAME` from `deploy.env`;
- secondary target, cron schedules, retention and alert lag;
- listener port, bind host and certificate paths under
  `BACKUP_DAEMON_CERT_DIR`;
- PostgreSQL primary host/port/user/password/database, audit database, replica
  list, data directories and binary directory;
- catalog, scratch paths/ports, scheduler settings and command timeout;
- WAL-G/Barman/redis-cli binary paths and the derived Redis URL.

The deploy also writes `/etc/pg-backup/wal-g.env`, plus
`/etc/pg-backup/wal-g-core.env` and `/etc/pg-backup/wal-g-audit.env` on the
archive hosts. It creates `/etc/systemd/system/pg-backup-daemon.service`,
`/etc/cron.d/pg-backup`, `/usr/local/bin/pg-backup-daemon-trigger` and
`/usr/local/bin/pg-backup-restore-drill`.

`BACKUP_DAEMON_CERT_DIR` and `BACKUP_PGPASSFILE` are deploy keys. The daemon
config does not validate `BACKUP_PGPASSFILE`, but the systemd environment still
passes it to Barman subprocesses. `PG_DB_NAME` is also present in the generated
environment but is not read by the daemon schema.

`backup.env.example` is a local/troubleshooting reference only. It is not the
production source of truth.

## 10. systemd and source deployment

The provisioner writes a unit equivalent to:

```ini
[Unit]
Description=Payment Gateway pg-backup-daemon (WAL-G / Barman control plane)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pgbackup
Group=pgbackup
WorkingDirectory=/opt/pg-backup-daemon
EnvironmentFile=/etc/pg-backup/backup.env
Environment=BACKUP_DAEMON_PORT=4090
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/pg-backup /var/log/pg-backup <catalog dir> <cert dir> <scratch dirs> <pgpass dir>

[Install]
WantedBy=multi-user.target
```

`deployBackupDaemon()` installs `/opt/pg-backup-daemon`, rsyncs the source with
`--delete` (excluding `node_modules`, `.git`, `dist`, `test`, `*.log`, `.env`),
chowns it to `pgbackup`, ensures `/usr/local/bin/bun`, runs
`bun install --frozen-lockfile` as `pgbackup`, and enables/restarts the unit.

When the scheduler is enabled, `/etc/cron.d/pg-backup` only contains a comment.
When it is disabled, the file drives full/delta triggers as `pgbackup` and the
weekly shell drill as root.

Certificate ownership is an open risk: the deploy uploads the daemon key/cert
through sudo (root-owned 0600 under a directory owned by `pgbackup`) and does not
chown the files to `pgbackup`. The daemon may be unable to read its key. Verify
ownership and startup on a staging host before claiming mTLS readiness.

## 11. Operations

### Local run

```bash
cd deploy/backup-daemon
bun install
bun run start
bun run typecheck
bun test
```

For local use without certificates, set `BACKUP_ALLOW_INSECURE_HTTP=true`
explicitly. Do not use that setting in production.

### Deployed service

```bash
systemctl status pg-backup-daemon
journalctl -u pg-backup-daemon --since '1 hour ago'
cat /etc/pg-backup/backup.env          # sensitive
```

### mTLS calls

The deployed trigger script uses `internal-ca.crt`, `backup-client.crt` and
`backup-client.key` from `BACKUP_DAEMON_CERT_DIR`:

```bash
CERT_DIR=/var/lib/pg-backup/shared/certs
HOST=10.10.13.10
PORT=4090

curl -fsS \
  --cacert "$CERT_DIR/internal-ca.crt" \
  --cert "$CERT_DIR/backup-client.crt" \
  --key "$CERT_DIR/backup-client.key" \
  "https://$HOST:$PORT/v1/overview"

curl -fsS \
  --cacert "$CERT_DIR/internal-ca.crt" \
  --cert "$CERT_DIR/backup-client.crt" \
  --key "$CERT_DIR/backup-client.key" \
  -H 'content-type: application/json' \
  -X POST \
  --data '{"target":"all","kind":"full"}' \
  "https://$HOST:$PORT/v1/backups/trigger"

curl -fsS \
  --cacert "$CERT_DIR/internal-ca.crt" \
  --cert "$CERT_DIR/backup-client.crt" \
  --key "$CERT_DIR/backup-client.key" \
  -H 'content-type: application/json' \
  -X POST \
  --data '{}' \
  "https://$HOST:$PORT/v1/drills/run"
```

Trigger and drill calls return `202`; poll `/v1/runs` and `/v1/drills` or the
catalog for completion. `/health` is liveness only; use `/v1/overview` for engine
health.

### Admin and core workflow

`core-back/lib/storageEngine/backupControlClient.ts` uses the internal CA and
`backup-client` certificate. Core exposes overview/trigger/drill/policy/catalog
under its internal backups API. `admin-back` applies `security:read` /
`security:write` and proxies the calls.

`PUT /policy` without an `approvalRequestId` creates a `BACKUP_POLICY` approval
and returns `202`. With an approved request id, core checks the subject type,
state and maker != checker, sends the approved payload to the daemon, marks the
approval `EXECUTED` and writes an audit record. The daemon endpoint itself does
not enforce this workflow.

## 12. Routine checks

- `/v1/overview` is healthy and every target has a detail.
- The latest full/delta run is `PASSED` and within the expected schedule.
- WAL archive lag is below `BACKUP_ALERT_LAG_SECONDS`.
- The latest drill is `PASSED`, signed, and its target time is recent.
- The catalog file exists and is writable; startup logs do not say
  "catalog is running in memory only".
- `systemctl status pg-backup-daemon` is active and the key is readable by
  `pgbackup`.
- The primary S3 bucket and optional secondary target are reachable.
- Barman mode also has a working WAL-G binary for the S3 health check.

## 13. Troubleshooting

| Symptom | Likely cause / action |
| :--- | :--- |
| Startup exits with a Zod message | Fix the named environment key. Cron must be five fields; the encryption key must be hex, even-length, >= 16 bytes; S3 keys must be paired. |
| `TLS requires ...` or `mTLS requires ...` | Set both cert/key and the CA, or explicitly allow insecure HTTP for local development only. |
| Daemon fails to start as `pgbackup` | Check ownership/mode of `BACKUP_DAEMON_CERT_PATH` and `BACKUP_DAEMON_KEY_PATH`; the deploy uploads them as root and does not chown them. |
| `/v1/overview` reports `primary-s3` unhealthy | Check endpoint/bucket/keys, `rclone`, and WAL-G. Barman health still uses WAL-G `st ls`. |
| `all` backup fails immediately | `all` includes `audit_db`; set `PG_AUDIT_DATA_DIR` (WAL-G), or configure the audit Barman server / `BARMAN_AUDIT_SERVER`. |
| Delta backup fails | WAL-G delta requires a prior base backup. Run a full first; the error text notes this. |
| `redis` target fails | Set `REDIS_URL`; Redis upload also requires `rclone` and a reachable core S3 prefix. |
| Drill fails at audit recovery | The drill requires the audit target; configure `PG_AUDIT_DATA_DIR` or the audit Barman server. |
| Drill leaves scratch directories | An interrupted cleanup can leave `/var/lib/pg-backup/scratch` content; inspect and remove only when no drill is running. |
| Policy update returns `400 validation_error` | `PUT /v1/policy` requires the full policy object, not a partial patch, and valid five-field crons. |
| Trigger returns `202` but nothing happens | Check the daemon log, `/v1/runs`, engine binary availability, and whether another scheduled job is running. HTTP triggers themselves are not serialized. |
| Catalog warning at startup | The path is unwritable or the JSON is corrupt; the daemon is running in memory and will lose history on restart. Fix permissions or remove the corrupt file. |
| Barman backup succeeds but health fails | Install WAL-G for the S3 check, or treat the S3 target result as a known Barman-mode limitation. |

## 14. Known gaps

- Backup daemon certificate/key files may be root-owned and unreadable by
  `pgbackup`; deploy readiness is unproven until a staging run checks effective
  ownership and mTLS startup.
- Barman health depends on the WAL-G binary and does not fully validate Barman's
  cloud/retention path.
- A backup target of `all` always includes `audit_db`, even when audit is not
  configured; WAL-G then fails without `PG_AUDIT_DATA_DIR`, and Barman needs an
  audit server.
- HTTP-triggered backups are not globally serialized; only the scheduler skips
  overlap with its own jobs.
- Log-database backups are not a daemon target; only core, audit and optional
  Redis are covered.
- The daemon accepts any CA-signed client certificate and does not authorize a
  client CN per route. A direct client can call `PUT /v1/policy` and bypass core
  maker-checker.
- The provisioned weekly shell drill only checks the core double-entry
  invariant; it does not run the balance-parity or audit-chain checks.
- The JSON catalog is unencrypted, count-retained and not itself backed up.
- There is no verify-only restore mode; every drill performs a full scratch
  restore of core and audit.
- WAL-G installation is a moving `latest` Ubuntu 20.04 binary and is not
  checksum-verified.
- The daemon's policy `fullRetentionDays` is metadata; WAL-G pruning uses
  `BACKUP_RETENTION_FULL_COUNT`.
- An interrupted drill cleanup can leave scratch clusters or directories.
- A failed drill still produces a signed `FAILED` report on the scheduled/HTTP
  paths; it does not restore the live database.

## 15. Tests

```bash
cd deploy/backup-daemon
bun run typecheck
bun test
cd ..
bun test test/provisioners.test.ts
```

| Suite | Tests | Coverage |
| :--- | ---: | :--- |
| `test/backupEngine.test.ts` | 18 | WAL-G/Barman command builders, target routing, audit refusal, parsing, mirroring, Redis. |
| `test/catalogStore.test.ts` | 6 | Atomic writes, corruption, retention, policy. |
| `test/commandRunner.test.ts` | 3 | Spawn, timeout, output capture. |
| `test/config.test.ts` | 7 | Defaults, validation, redaction. |
| `test/cron.test.ts` | 8 | Five-field cron parsing and next-run calculation. |
| `test/restoreDrillRunner.test.ts` | 10 | Drill success/failure, initdb guard, audit-chain verification, cleanup. |
| `test/scheduler.test.ts` | 3 | Policy reload, overlap skipping, state. |
| `test/server.test.ts` | 16 | HTTP contract, validation, redaction, mTLS refusal, async jobs. |

Not covered: a real WAL-G/Barman backup or restore, a real PostgreSQL 18 scratch
drill, daemon startup as `pgbackup` with deployed certificate ownership,
Barman-only health, or core maker-checker against the daemon.

## 16. Design links

Canonical design:

- [`project-design/parts/07-deploy/06-backup-daemon.md`](../../project-design/parts/07-deploy/06-backup-daemon.md)
- [`project-design/parts/07-deploy/05-storage-provisioners.md`](../../project-design/parts/07-deploy/05-storage-provisioners.md)
- [`project-design/parts/07-deploy/07-health-rollback-and-recovery.md`](../../project-design/parts/07-deploy/07-health-rollback-and-recovery.md)
- [`project-design/parts/01-core-back/09-backup-control.md`](../../project-design/parts/01-core-back/09-backup-control.md)
- [`project-design/appendices/env-and-config-matrix.md`](../../project-design/appendices/env-and-config-matrix.md)

Historical reference only:

- [`design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md`](../../design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md)
- [`design/03-deployment/payment_gateway_deployment_and_guides_architecture.md`](../../design/03-deployment/payment_gateway_deployment_and_guides_architecture.md)

Related operator docs:

- [`deploy/README.md`](../README.md)
- [`deploy/DEPLOYMENT_GUIDE.md`](../DEPLOYMENT_GUIDE.md)
- [`backup.env.example`](backup.env.example)
