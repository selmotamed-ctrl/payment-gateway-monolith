---
id: core.backup
title: Backup Control
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: 5a24f6f+working-tree
code:
  - core-back/api/internal/backups.ts
  - core-back/lib/storageEngine/backupControlClient.ts
  - deploy/backup-daemon/src/**
  - deploy/provisioners/backupEngineProvisioner.ts
  - deploy/lib/hostPlanner.ts
  - deploy/deploy.ts
  - admin-back/api/protected/backups.ts
  - admin-front/src/pages/system/backups/index.tsx
tests:
  - core-back/test/backup-admin/**
  - deploy/backup-daemon/test/**
  - tests/e2e/admin/backups.spec.ts
gaps:
  - Backup daemon TLS certificates are written as root and are not chowned to `pgbackup`.
  - The restore drill connects to the restored audit cluster with the core database user, not the audit runtime role.
  - Barman is configured with a `barman_audit` slot but the provisioner only creates the `barman` slot.
  - The WAL archive-lag query can fail when `last_archived_wal` is empty.
  - The policy retention days are stored but WAL-G prune uses a fixed full-backup count and Barman uses static server retention.
  - Secondary mirroring exists only for WAL-G targets, not Barman or Redis.
  - Redis has no dedicated schedule; it is captured only when `target=all` runs.
  - Cron schedules are evaluated in UTC, not the Tripoli local time stated by older docs.
  - Barman health probes still invoke the WAL-G binary and WAL-G health queries.
  - Trigger and drill are not maker-checker protected; only policy updates are.
  - The admin BFF exposes overview/trigger/drill/policy but not the local `/catalog` route.
---

# Backup Control

## 1. Purpose and scope

Backup control is the administrator-facing plane for PostgreSQL point-in-time recovery, the dedicated audit database, and optional Redis snapshots. It spans three layers:

- `core-back` internal APIs and `BackupControlClient`;
- the standalone `pg-backup-daemon` in `deploy/backup-daemon`, which wraps WAL-G or Barman and owns the schedule, catalog and restore drill;
- the admin BFF and the admin portal backup page.

This part owns:

- the backup daemon contract (`/health`, `/v1/overview`, `/v1/backups/trigger`, `/v1/policy`, `/v1/runs`, `/v1/drills/run`, `/v1/drills`);
- target selection (`all`, `postgres_core`, `audit_db`, `redis`);
- full and delta backup execution;
- the in-process full/delta/drill scheduler and UTC cron parser;
- the JSON catalog of runs, drills and policy;
- the maker-checker policy update workflow;
- the scratch-restore and invariant drill;
- catalog synchronization into `backup_catalog_runs` and `backup_restore_drills`;
- the admin UI overview, trigger, drill and policy forms.

It does not own the core database schema, storage-engine read path, or the deployment certificate PKI. Those are documented in `core.data`, `core.storage` and `07-deploy`.

## 2. Design intent (extracted and synthesized from ./design)

The historical storage blueprint defines an admin-managed backup orchestrator:

- a dedicated daemon wraps WAL-G and Barman, so operators do not run ad-hoc commands;
- the daemon is reached over mTLS from core, and core is the only service allowed to call it;
- administrators can trigger full/delta backups, run restore drills and change the schedule/retention policy;
- policy changes require maker-checker approval;
- backups cover the core database, the dedicated audit database and Redis;
- the daemon writes to a primary S3/MinIO/R2 bucket and optionally mirrors to a secondary SSH/S3 vault;
- a restore drill restores the latest base backup plus WAL to a scratch PostgreSQL instance, then verifies double-entry zero drift, sharded balance parity and audit hash-chain integrity;
- the drill report is signed and stored;
- the scheduler runs weekly full, weekday delta and weekly drill jobs.

The design's false or outdated claims are corrected here:

- the scheduler does not run at Tripoli 03:00; it evaluates five-field cron expressions in UTC;
- there is no hourly Redis BGSAVE schedule; Redis is snapshotted only when a triggered or scheduled `target=all` backup includes it;
- the audit shipper does not delete rows (this is a storage-engine behavior, but it affects backup scope);
- the backup certificates are generated and distributed but are not proven ready-to-run for the `pgbackup` daemon user; ownership is not fixed;
- the daemon policy retention fields are not the values WAL-G/Barman actually apply;
- Barman mode does not mirror to the secondary target and its health still uses WAL-G commands;
- the restore drill has a role mismatch for the audit database.

## 3. As-built architecture

### 3.1 Core internal API

`core-back/api/internal/backups.ts` mounts under `/internal/admin/system/backups` and requires internal mTLS identity plus authorities:

| Route | Authorities | Behavior |
| :--- | :--- | :--- |
| `GET /overview` | `security:read` and `gateway:read` | Reads local catalog runs/drills, optionally fetches the daemon overview, syncs the daemon catalog into local tables, returns a merged payload |
| `POST /trigger` | `security:write` | Validates `{ target, kind }`, requires a configured daemon, calls the daemon, inserts a local `QUEUED` run |
| `POST /drill` | `security:write` | Requires a configured daemon, calls the daemon, inserts a local `QUEUED` drill with target time now minus 5 minutes |
| `PUT /policy` | `security:write` | Creates or executes a maker-checker approval, then updates the daemon policy |
| `GET /catalog` | `security:read` and `gateway:read` | Returns only the local `backup_catalog_runs` and `backup_restore_drills` |

The policy schema is strict: three five-field cron expressions, `fullRetentionDays`, `walRetentionDays`, `alertLagSeconds` and an optional `approvalRequestId`. Defaults exposed when the daemon is absent are:

- full: `0 2 * * 0`;
- delta: `0 2 * * 1-6`;
- drill: `0 4 * * 0`;
- full retention: 56 days;
- WAL retention: 14 days;
- alert lag: 60 seconds.

The trigger schema defaults `target` to `all` and `kind` to `full`.

### 3.2 Core policy maker-checker

`PUT /policy` without `approvalRequestId` creates an `ApprovalRequest`:

- `subjectType = "BACKUP_POLICY"`;
- `subjectId = "backup-policy"`;
- `payloadDiffJson` = the validated policy;
- `mode = "STANDARD"`;
- `makerUserId` = the current actor;
- `state = "PENDING_REVIEW"`;
- expiry 7 days.

It returns HTTP 202 with `checkerRequired: true` and the approval id.

With `approvalRequestId`, core:

1. loads the approval and requires `subjectType = "BACKUP_POLICY"`;
2. requires state `PENDING_REVIEW` or `APPROVED`;
3. rejects when `approval.makerUserId === actor.userId` with `MAKER_CHECKER_VIOLATION`;
4. requires the daemon to be configured;
5. applies `approval.payloadDiffJson` to the daemon (not the current request body);
6. marks the approval `EXECUTED`, records `checkerUserId` and increments `baseVersion`;
7. writes a `BACKUP_POLICY_UPDATED` audit row with before/after JSON and a stable-JSON checksum prefix.

There is no maker-checker on `POST /trigger` or `POST /drill`; both are direct `security:write` actions.

### 3.3 Catalog synchronization

`GET /overview` reads local runs and drills first, then checks whether the daemon is configured. If configured, it calls `GET /v1/overview`; on success it calls `syncDaemonCatalog`:

- every daemon backup run is upserted into `backup_catalog_runs` by id;
- every daemon drill is upserted into `backup_restore_drills` by id;
- `sizeBytes` is converted to `BigInt`;
- `storageTargets` and drill checks are stored as JSON;
- errors are swallowed per write with `Promise.allSettled`, so a partial sync does not fail the overview.

The response includes both the daemon view and `localCatalog: { backups, drills }`. If the daemon is unreachable, the response returns local rows and `daemonReachable: false` with `daemonError`.

`GET /catalog` never calls the daemon. The admin BFF does not proxy it, so the portal cannot use it directly.

### 3.4 Backup control client

`core-back/lib/storageEngine/backupControlClient.ts`:

- reads `BACKUP_DAEMON_URL`, `BACKUP_DAEMON_TIMEOUT_MS`, and optional CA/client cert/key paths;
- uses `http.Agent` for plain HTTP and `https.Agent` with `minVersion: "TLSv1.3"`, CA and client certificate for HTTPS;
- serializes JSON manually, sets content length, parses JSON responses and maps daemon error envelopes to `BackupDaemonError` with code/status/details;
- maps unreachable errors to 502 and timeouts to 504;
- throws `BackupDaemonNotConfiguredError` (503) when no URL is configured;
- exposes a singleton and `resetBackupControlClient()` for tests.

The client has no retries, backoff or circuit breaker. A transient daemon failure is surfaced to the operator.

### 3.5 Daemon HTTP API

`deploy/backup-daemon/src/server.ts` serves an mTLS HTTP API (plain HTTP only with `BACKUP_ALLOW_INSECURE_HTTP=true`):

| Method | Path | Behavior |
| :--- | :--- | :--- |
| `GET` | `/health` | `{ status: "ok", engineMode, version }` |
| `GET` | `/v1/overview` | Engine health, WAL health, storage targets, schedule, policy, recent runs, latest/recent drills |
| `POST` | `/v1/backups/trigger` | Validates target/kind, allocates an id, queues a background run, returns 202 |
| `PUT` | `/v1/policy` | Validates and persists cron/retention/alert policy, returns the updated policy |
| `GET` | `/v1/runs?limit=` | Recent catalog runs |
| `POST` | `/v1/drills/run` | Queues a restore drill, returns 202 |
| `GET` | `/v1/drills?limit=` | Recent drill reports |

The server:

- caps request bodies at 256 KiB;
- validates with Zod and returns structured `{ error: { code, message, details } }` envelopes;
- adds a request id and `cache-control: no-store`;
- redacts configured secret values and credential-shaped keys from responses and logs;
- tracks background tasks for graceful shutdown;
- assigns unique ids and refuses conflicts with existing catalog ids.

### 3.6 Engines: WAL-G and Barman

`deploy/backup-daemon/src/backupEngine.ts` defines `BACKUP_TARGETS = ["all", "postgres_core", "audit_db", "redis"]`, `BACKUP_KINDS = ["full", "delta"]`, and `RECOVERY_TARGETS = ["postgres_core", "audit_db"]`.

WAL-G mode:

- base backup: `wal-g backup-push <data-dir>`;
- delta: `wal-g backup-push --delta <data-dir>`;
- verify: `wal-g st ls <prefix>`;
- mirror: `rclone copy` for S3/rclone destinations, otherwise `rsync -a` to the secondary target; neither deletes extraneous files unless `BACKUP_SECONDARY_MIRROR_DELETE=true` (then `rclone sync` / `rsync --delete`);
- list: `wal-g backup-list --json`;
- prune: `wal-g delete retain FULL <BACKUP_RETENTION_FULL_COUNT> --confirm`;
- recover: `wal-g backup-fetch <dir> LATEST` plus a generated `recovery_target_time` and `recovery_target_action = 'promote'` config;
- Redis: `redis-cli -u <url> BGSAVE`, `redis-cli --rdb <tmp>`, then `rclone copyto <tmp> <core-prefix>/redis/dump.rdb`.

Barman mode:

- `barman check <server>` for core and audit;
- `barman backup <server>` or `barman backup --incremental <server>`;
- `barman-cloud-backup` to the primary S3 target;
- `barman list-backup <server>` for listing;
- `barman recover --target-time ... <server> <backup> <dir>` for recovery;
- no daemon-side prune; the comment says Barman applies its own `retention_policy`.

`backupDataDir` refuses the audit target when `PG_AUDIT_DATA_DIR` is absent, so `target=all` fails rather than silently backing up the core data directory under the audit prefix.

### 3.7 Scheduler

`deploy/backup-daemon/src/scheduler.ts` implements an in-process scheduler:

- `SCHEDULED_JOBS = ["full", "delta", "drill"]`;
- policy changes are re-read every tick, so `PUT /v1/policy` takes effect without restart;
- the next run is computed with `nextCronRun` from `cron.ts`;
- a tick skips a due job if another backup/drill is still running and logs a warning;
- full/delta run `engine.triggerBackup("all", kind)`;
- after a successful full run, the scheduler calls `engine.prune("all", "full")`;
- drill runs `RestoreDrillRunner.run({ requestedBy: "scheduler" })` and adds the report to the catalog;
- failed jobs produce `FAILED` catalog entries; a failed drill gets a signed failed report.

Defaults: full Sunday 02:00, delta Monday–Saturday 02:00, drill Sunday 04:00, tick every 30 seconds. All cron evaluation is UTC (`cron.ts` uses `getUTC*` and `setUTC*`), with no timezone or DST configuration.

When `SCHEDULER_ENABLED=false`, the deploy provisioner writes a `/etc/cron.d/pg-backup` file with the same three jobs, invoking the trigger script or the legacy restore-drill script. The production default is the in-process scheduler with an explanatory cron file. The system-cron fallback uses the host time zone, so it is not equivalent to the UTC scheduler.

### 3.8 Catalog

`deploy/backup-daemon/src/catalogStore.ts` is a JSON catalog at `BACKUP_CATALOG_PATH`:

- `BackupCatalog = { runs, drills, policy }`;
- atomic write-through temp file plus rename;
- load-time Zod validation with a warning and fallback when the file is corrupt;
- in-memory operation continues when persistence fails, with `isPersistent()` and `getPersistenceError()`;
- default policy `fullRetentionDays: 56`, `walRetentionDays: 14`, `alertLagSeconds: 300`;
- in-memory cap of 500 runs and 100 drills, independent of the policy retention fields.

The catalog is daemon-local. Core synchronizes it into PostgreSQL only when `/overview` is fetched successfully. There is no reverse synchronization from core to the daemon.

### 3.9 Restore drill

`deploy/backup-daemon/src/restoreDrillRunner.ts`:

1. computes `targetTime = now - 5 minutes`;
2. stops and removes both scratch directories (`BACKUP_SCRATCH_DIR`, `BACKUP_SCRATCH_AUDIT_DIR`);
3. recovers the core and audit clusters through `engine.recover`;
4. if the restore did not produce a `PG_VERSION`, runs `initdb -U PG_PRIMARY_USER --auth=trust` (core and audit);
5. appends recovery settings and creates `recovery.signal`;
6. starts both scratch clusters on `127.0.0.1` at their configured ports;
7. verifies double-entry drift is zero;
8. counts journal lines;
9. verifies sharded balance parity against `gl_accounts`/`gl_account_shards`;
10. verifies the audit hash chain;
11. stops and removes the scratch directories in `finally`;
12. returns a report with checks, counts, drift, replayed LSN, error and an HMAC-SHA256 signature over stable JSON using `BACKUP_ENCRYPTION_KEY_HEX`.

The scratch clusters use `--auth=trust` and listen only on loopback. The drill does not restore Redis and does not validate Redis contents.

### 3.10 Admin BFF and UI

`admin-back/api/protected/backups.ts` proxies overview/trigger/drill/policy under `/api/v1/admin/system/backups` with the same authority split as core. It does not expose `/catalog`.

`admin-front/src/pages/system/backups/index.tsx`:

- loads the overview on mount and polls it on the page's refresh cycle;
- shows daemon reachability, engine mode, WAL health, target health, schedule, policy, recent backups and latest drill;
- displays double-entry, parity and audit-chain checks from the drill report;
- opens a trigger dialog with target and kind;
- runs a drill with a confirmation dialog;
- opens a policy dialog and submits `PUT /policy`; because the first call returns `PENDING_REVIEW`, the page surfaces the approval id rather than pretending the policy changed;
- disables actions when the daemon is not configured or unreachable.

## 4. Contracts and invariants

- Only core may call the daemon in a deployment; the listener is private and requires mTLS by default.
- The daemon must be configured before trigger/drill/policy; without `BACKUP_DAEMON_URL` the result is 503, never a silent no-op.
- `target` is one of `all`, `postgres_core`, `audit_db`, `redis`; `kind` is `full` or `delta`.
- `target=all` includes core, audit and Redis when configured. If `PG_AUDIT_DATA_DIR` is missing the whole trigger fails; the core data directory is never used for the audit prefix.
- Policy changes require a different maker and checker; the approved payload, not the current request body, is applied.
- The in-process scheduler uses five-field cron expressions evaluated in UTC. The fallback `/etc/cron.d` file is interpreted by host cron in its local time zone. A full scheduled backup prunes full backups in WAL-G mode; delta does not prune.
- Restore drills target now minus five minutes, are destructive only to scratch directories, run loopback-only and are cleaned up before the report returns.
- Drill reports are signed and stored; core copies the signature when it syncs.
- Catalog writes are atomic at the file level; a failed write is surfaced but does not stop the daemon.
- The daemon must never return or log encryption keys, S3 credentials, database passwords or private key material.

## 5. Data / API / config / deployment surface

### Core models and routes

- `BackupCatalogRun` — id, target, kind, engine, status, timestamps, duration, size, start/end LSN, storage targets JSON, error.
- `BackupRestoreDrill` — id, status, timestamps, target time, replayed LSN, double-entry drift, balance mismatches, audit broken links, journal line count, checks JSON, signature, error.
- `ApprovalRequest` — backs the policy maker-checker workflow with `subjectType = "BACKUP_POLICY"`.
- Core routes: `GET /internal/admin/system/backups/overview`, `POST /trigger`, `POST /drill`, `PUT /policy`, `GET /catalog`.
- Admin BFF routes: `GET /api/v1/admin/system/backups/overview`, `POST /trigger`, `POST /drill`, `PUT /policy`.

### Daemon environment (selected)

| Key | Purpose | Default |
| :--- | :--- | :--- |
| `BACKUP_ENGINE_MODE` / `BACKUP_COMPRESSION` / `BACKUP_ENCRYPTION_KEY_HEX` | Engine, compression, encryption/signing key | mode required, `zstd`, key required |
| `BACKUP_PRIMARY_S3_*` / `BACKUP_CORE_S3_PREFIX` / `BACKUP_AUDIT_S3_PREFIX` | Primary bucket and per-database prefixes | endpoint/bucket required, prefixes derived |
| `BACKUP_SECONDARY_SSH_TARGET` | Optional secondary vault | empty |
| `BACKUP_FULL_CRON` / `BACKUP_DELTA_CRON` / `BACKUP_DRILL_CRON` | UTC schedules | `0 2 * * 0`, `0 2 * * 1-6`, `0 4 * * 0` |
| `BACKUP_RETENTION_FULL_COUNT` / `BACKUP_RETENTION_WAL_DAYS` | WAL-G full count / Barman window and displayed policy | `8` / `14` |
| `BACKUP_ALERT_LAG_SECONDS` / `SCHEDULER_ENABLED` / `SCHEDULER_TICK_MS` | Alert threshold and scheduler | `300`, `true`, `30000` |
| `BACKUP_DAEMON_PORT` / `BIND_HOST` / `CERT_PATH` / `KEY_PATH` / `CA_CERT_PATH` / `BACKUP_ALLOW_INSECURE_HTTP` | Listener and mTLS | `4090`, `127.0.0.1`, unset, `false` |
| `PG_PRIMARY_*` / `PG_AUDIT_DB_NAME` / `PG_AUDIT_DATA_DIR` / `PG_REPLICA_NODES` | Database connections and audit target | local defaults, unset, empty |
| `PG_DATA_DIR` / `PG_BIN_DIR` / `WALG_BIN` / `BARMAN_BIN` / `BARMAN_CLOUD_BIN` | Data and binaries | PostgreSQL 18 defaults, standard names |
| `BARMAN_SERVER` / `BARMAN_AUDIT_SERVER` / `BACKUP_CATALOG_PATH` | Barman names and catalog | core DB name / audit DB name, `/var/lib/pg-backup/catalog.json` |
| `BACKUP_SCRATCH_DIR` / `SCRATCH_PORT` / `AUDIT_DIR` / `AUDIT_PORT` / `BACKUP_COMMAND_TIMEOUT_MS` | Drill scratch and command ceiling | `/var/lib/pg-backup/scratch`, 55432/55433, 30 minutes |
| `REDIS_URL` / `REDIS_CLI_BIN` | Optional Redis snapshot | unset / `redis-cli` |

### Deploy surface

`deploy/provisioners/backupEngineProvisioner.ts` writes `/etc/pg-backup/backup.env`, `/etc/pg-backup/wal-g.env`, the `pgbackup` systemd unit, `/etc/cron.d/pg-backup`, the trigger and restore-drill scripts, Barman configuration/PGPASSFILE in Barman mode, archive_command/restore_command settings and the journal partition cron.

`deploy/deploy.ts` syncs the daemon source to `/opt/pg-backup-daemon`, chowns the install directory to `pgbackup`, uploads storage certificates to `BACKUP_DAEMON_CERT_DIR`, and enables the unit. `deploy/lib/hostPlanner.ts` injects `BACKUP_DAEMON_URL` and the client cert paths into core.

## 6. Operational usage

- Set `BACKUP_DAEMON_URL` and client CA/cert/key paths in core. Use HTTPS in production; plain HTTP is local only.
- Ensure the daemon has a primary S3 bucket and an encryption key. A typo fails at boot, not during a restore.
- For a manual backup, call the admin page or `POST /trigger`; poll `/overview` or `/runs` for completion.
- For `target=all`, confirm `PG_AUDIT_DATA_DIR` is set and the audit database is reachable.
- For a policy change, submit without an approval id, then have a different `security:write` user submit with the returned id.
- Watch `archiveLagSeconds` against `BACKUP_ALERT_LAG_SECONDS`. A non-zero lag with a healthy bucket usually means archive_command, credentials or the archive process is failing.
- Inspect `backup_catalog_runs` and `backup_restore_drills` for the local copy and the daemon catalog for the in-process view. A failed drill's three checks identify double-entry, parity or audit-chain failure.
- After a real restore, verify schema version 10, the ledger invariant, shard parity and audit chain.
- Do not rely on policy `fullRetentionDays` for WAL-G pruning; WAL-G uses `BACKUP_RETENTION_FULL_COUNT` and Barman uses its server-side policy.

## 7. Status and deviations

### Implemented

- Core backup internal routes and authority checks.
- mTLS backup control client with typed errors and timeouts.
- Daemon `/health`, overview, trigger, policy, runs and drills routes.
- WAL-G base/delta backup, verify, list, mirror, prune and recover command builders.
- Barman check/backup/list/recover paths; Redis BGSAVE/RDB/upload when configured.
- In-process UTC cron scheduler with policy hot-reload and skip-on-overlap.
- JSON catalog with atomic writes, validation, in-memory fallback and caps.
- Policy maker-checker through `ApprovalRequest`, with maker ≠ checker enforcement.
- Restore drill with double-entry, parity and audit-chain checks, signed reports and scratch cleanup.
- Catalog synchronization from daemon overview into core tables.
- Admin BFF proxy and admin backup page with trigger/drill/policy flows.
- Unit tests for the daemon, core client/routes and the Playwright backup page.

### Partial

- Target-aware backups: `all` works, but Redis is coupled to `all` and has no independent schedule.
- Secondary vault: WAL-G core/audit backups mirror; Barman and Redis do not.
- Retention: the policy is stored and displayed, but effective WAL-G/Barman behavior is driven by other settings.
- Health: WAL health uses archive/replay queries and can be degraded by an empty archive; Barman mode still uses WAL-G commands.
- Drill: core and audit are tested with fake command runners; no live end-to-end restore is in the default suite.
- Policy: only policy updates are maker-checker protected; trigger and drill are single-actor actions.

### Missing / deferred

- Certificate ownership fix: files under `BACKUP_DAEMON_CERT_DIR` are uploaded as root with mode 0600 and no `chown pgbackup`, so the daemon cannot read them.
- Audit drill role mapping: the restored audit cluster is queried with `PG_PRIMARY_USER`, while the audit database uses `AUDIT_DB_USER`.
- Barman audit slot: `barmanConfig` declares `slot_name = barman_audit`, but `barmanStreamingSql()` only creates the `barman` slot.
- WAL archive lag correctness: `WAL_ARCHIVE_STATUS_QUERY` passes `COALESCE(last_archived_wal, '')` to `pg_wal_lsn_diff`, and an empty string is not a valid `pg_lsn`.
- WAL replay lag semantics: `WAL_LAG_QUERY` uses replay/receive LSN on the first replica (or primary) and is labeled `lastArchivedLsn`; it is not the archive lag.
- Retention enforcement: WAL-G prune uses the environment full count; catalog policy days are not applied. Barman uses a static server policy.
- Secondary mirroring for Barman/Redis: Barman returns only `primary-s3`; Redis writes only to the core prefix.
- Redis schedule: no `redis` cron; scheduled full/delta jobs use `target=all`, and a `delta` Redis run still performs a full BGSAVE/RDB copy.
- UTC cron: the in-process scheduler has no timezone field and evaluates UTC; the system-cron fallback uses host local time, so the historical Tripoli schedule is not honored consistently.
- Barman health: `BarmanEngine.overviewHealth` still calls WAL-G bucket/WAL commands.
- Catalog exposure and destructive-action controls: admin-back does not proxy `/catalog`; trigger/drill are not maker-checker protected.
- Restore drill target selection: the drill always uses now minus 5 minutes.

### Known bugs / risks

- The certificate ownership gap blocks the intended mTLS daemon path; code/deploy gap.
- The audit role mismatch can produce a false `FAILED` drill on a correctly restored audit database; code gap.
- The `barman_audit` slot mismatch can break audit streaming while core works; code gap.
- An empty `last_archived_wal` can make health report zero lag instead of "no archive yet"; code gap.
- The scheduler advances `next` before skip-on-overlap, so a long-running job can silently miss a slot; code risk.
- A failed prune is only logged, while the backup remains `PASSED`; operational risk.
- The daemon catalog cap diverges from the unbounded PostgreSQL history; design gap.
- The first policy submission returns `PENDING_REVIEW`; an operator who skips the checker step may believe the schedule changed; UX risk.
- Scratch port collisions fail the drill; operational risk.
- `target=all` fails when audit is not configured; select `postgres_core` explicitly for core-only backups.

## 8. Verification and tests

Relevant test files:

- `core-back/test/backup-admin/backup-control-client.test.ts` — client requests, TLS options, typed errors, timeouts and singleton reset.
- `core-back/test/backup-admin/backup-admin-routes.test.ts` — overview/trigger/drill/policy/catalog behavior against a fake daemon and live PostgreSQL.
- `deploy/backup-daemon/test/config.test.ts` — environment validation, redaction and defaults.
- `deploy/backup-daemon/test/cron.test.ts` — five-field parser, UTC evaluation and next-run calculation.
- `deploy/backup-daemon/test/backupEngine.test.ts` — command builders, WAL-G/Barman selection, Redis snapshot commands, WAL queries and pruning.
- `deploy/backup-daemon/test/catalogStore.test.ts` — atomic writes, corrupt-file fallback, caps and policy.
- `deploy/backup-daemon/test/scheduler.test.ts` — due-job selection, overlap skipping, policy reload, prune and drill.
- `deploy/backup-daemon/test/server.test.ts` — routes, validation, redaction, background tasks and mTLS-related options.
- `deploy/backup-daemon/test/restoreDrillRunner.test.ts` — scratch restore orchestration, checks, signature and failure reports.
- `tests/e2e/admin/backups.spec.ts` — admin backup page behavior with mocked APIs.

Commands:

```bash
cd core-back && bun test test/backup-admin
cd deploy/backup-daemon && bun test
cd deploy && bun test
cd tests && bunx playwright test -c playwright.config.ts -g "backup"
```

Core backup-admin route tests that touch PostgreSQL skip when the database is unreachable. The daemon tests are unit-level and use fake command runners/file systems; they do **not** run a real WAL-G/Barman backup or a real PostgreSQL restore. The Playwright backup test mocks the API and needs no live stack. No test or benchmark was run for this documentation change.

## 9. Source references

### Old design sections

- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#5-segment-4--backup-management-orchestrator--admin-control-plane-pg-backup-daemon--core-back--admin-front`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#5-1-architecture-wrapping-wal-g--barman-with-an-admin-accessible-control-plane`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#5-2-core-back--admin-front-backup-management-api-contract`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#6-segment-5--horizontal-node-scaling--multi-host-storage-orchestration-in-deploydeployenv--deploydeployts`
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md`
- `design/00-process/blueprint-management.md#5-documentation-corrections-backlog`

### Code paths

- `core-back/api/internal/backups.ts`
- `core-back/lib/storageEngine/backupControlClient.ts`
- `core-back/lib/storageEngine/auditAndLogAdapters.ts`
- `core-back/lib/audit/writeAudit.ts`
- `core-back/prisma/schema.prisma` (`BackupCatalogRun`, `BackupRestoreDrill`, `ApprovalRequest`)
- `deploy/backup-daemon/src/index.ts`
- `deploy/backup-daemon/src/config.ts`
- `deploy/backup-daemon/src/server.ts`
- `deploy/backup-daemon/src/backupEngine.ts`
- `deploy/backup-daemon/src/scheduler.ts`
- `deploy/backup-daemon/src/cron.ts`
- `deploy/backup-daemon/src/catalogStore.ts`
- `deploy/backup-daemon/src/restoreDrillRunner.ts`
- `deploy/backup-daemon/src/commandRunner.ts`
- `deploy/provisioners/backupEngineProvisioner.ts`
- `deploy/lib/hostPlanner.ts`
- `deploy/deploy.ts`
- `admin-back/api/protected/backups.ts`
- `admin-front/src/pages/system/backups/index.tsx`

### Generated appendices

- `project-design/appendices/api-route-matrix.md` — core, BFF and portal backup routes
- `project-design/appendices/env-and-config-matrix.md` — daemon and core backup environment keys
- `project-design/appendices/schema-catalog.md` — backup catalog/drill models
- `project-design/appendices/migration-catalog.md` — migration that introduced the backup models

## 10. Change history

- 2026-11-03 — Initial canonical extraction. Records the core API, daemon API, WAL-G/Barman engines, UTC scheduler, JSON catalog, policy maker-checker, restore drill, catalog sync and target-aware behavior, plus the certificate ownership, audit role, Barman slot, WAL lag, retention, secondary mirroring, Redis schedule, UTC cron and Barman health gaps. See `project-design/TRACKER.md`.

## 11. Security hardening (2026-11-05)

- Off-site mirroring no longer deletes by default; set `BACKUP_SECONDARY_MIRROR_DELETE=true` to opt in.
- Admin edge backup trigger/drill calls require an `Idempotency-Key` header that is relayed to core; policy cron and retention floors are validated at the edge (see the admin edge part).
- The backup daemon authorizes its mTLS clients by certificate CN/SAN; see the backup daemon part.
