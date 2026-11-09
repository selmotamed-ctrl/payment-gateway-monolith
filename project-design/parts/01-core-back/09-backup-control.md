---
id: core.backup
title: Backup Control
status: partial
confidence: high
last_verified: 2026-11-08
verified_against: 747d9bc+working-tree
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
  - Secondary mirroring for the WAL-G/Barman engines covers WAL-G targets only; pg-native mirrors every artifact, WAL file and the catalog to every configured tier.
  - Redis has no dedicated schedule; it is captured only when `target=all` runs.
  - Cron schedules are evaluated in UTC, not the Tripoli local time stated by older docs.
  - Trigger and drill are not maker-checker protected; only policy updates are.
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

With `approvalRequestId`, core calls `executeBackupPolicyApproval` (`core-back/api/internal/backups.ts`). The same function backs `POST /approvals/:id/approve` for a `BACKUP_POLICY` approval, so the two entry points cannot differ:

1. the caller must hold checker authority (`approval:check`); `security:write` alone is refused with `403 APPROVAL_CHECKER_AUTHORITY_REQUIRED`;
2. it loads the approval and requires `subjectType = "BACKUP_POLICY"` (`404 APPROVAL_NOT_FOUND` otherwise);
3. it rejects `approval.makerUserId === actor.userId` with `409 APPROVAL_MAKER_EQUALS_CHECKER`;
4. it requires state `PENDING_REVIEW` or `DRAFT` (`409 APPROVAL_NOT_PENDING`; an `APPROVED`, `EXECUTED` or `REJECTED` request can never be applied again) and an unexpired request (`409 APPROVAL_EXPIRED`);
5. it requires the daemon to be configured (`503`);
6. it CLAIMS the approval with a conditional `updateMany` (pending -> `APPROVED`, `checkerUserId` set) BEFORE calling the daemon, so two checkers racing apply the policy exactly once (the loser gets `409 APPROVAL_NOT_PENDING`);
7. it applies `approval.payloadDiffJson` to the daemon (not the current request body) with `updatedBy` set to the checker; if the daemon call fails the claim is released (back to `PENDING_REVIEW`, `checkerUserId` cleared) so the request can be retried;
8. in one transaction it marks the approval `EXECUTED`, records `checkerUserId`, increments `baseVersion` and writes a `BACKUP_POLICY_UPDATED` audit row (`entityId` = the approval id) with before/after JSON and a stable-JSON checksum prefix.

Residual: if the process dies after the daemon accepted the policy but before step 8, the approval stays `APPROVED` with the checker recorded and the policy is already live; the daemon call is idempotent, but there is no automatic resume of that state.

There is no maker-checker on `POST /trigger` or `POST /drill`; both are direct `security:write` actions.

### 3.3 Catalog synchronization

`GET /overview` adds `walArchiveHealthy` (the daemon is healthy AND `wal.archiveLagSeconds` is within the policy `alertLagSeconds`; false when the daemon is unconfigured or unreachable), which certification gate 10 reads. It reads local runs and drills first, then checks whether the daemon is configured. If configured, it calls `GET /v1/overview`; on success it calls `syncDaemonCatalog`:

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

`admin-back/api/protected/backups.ts` proxies overview/catalog/trigger/drill/policy under `/api/v1/admin/system/backups` with the same authority split as core (`GET /catalog` needs `security:read` or `gateway:read` and stays available while the daemon is in maintenance). A well-formed `Idempotency-Key` on trigger/drill is relayed to core.

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
- Admin BFF routes: `GET /api/v1/admin/system/backups/overview`, `GET /catalog`, `POST /trigger`, `POST /drill`, `PUT /policy`.

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

`deploy/deploy.ts` syncs the daemon source to `/opt/pg-backup-daemon`, chowns the install directory and the certificate directory to the daemon user (`pgbackup`, or `postgres` for wal-g co-located with the primary), uploads storage certificates to `BACKUP_DAEMON_CERT_DIR`, enables the unit and waits for it to stay active. `deploy/lib/hostPlanner.ts` (`backupCoreEnv`) injects `BACKUP_DAEMON_URL`, the client cert paths and `BACKUP_DAEMON_TIMEOUT_MS` into core whenever `BACKUP_ENABLED`, independent of `pgStorageConfigured`.

## 6. Operational usage

- Set `BACKUP_DAEMON_URL` and client CA/cert/key paths in core. Use HTTPS in production; plain HTTP is local only.
- Ensure the daemon has a primary S3 bucket and an encryption key. A typo fails at boot, not during a restore.
- For a manual backup, call the admin page or `POST /trigger`; poll `/overview` or `/runs` for completion.
- For `target=all`, the audit database is backed up logically when it shares the primary cluster, or physically when `PG_AUDIT_DATA_DIR`/`PG_AUDIT_HOST` mark a dedicated cluster; confirm it is reachable.
- For a policy change, submit without an approval id, then have a different `security:write` user submit with the returned id.
- Watch `archiveLagSeconds` against `BACKUP_ALERT_LAG_SECONDS`. A non-zero lag with a healthy bucket usually means archive_command, credentials or the archive process is failing.
- Inspect `backup_catalog_runs` and `backup_restore_drills` for the local copy and the daemon catalog for the in-process view. A failed drill's three checks identify double-entry, parity or audit-chain failure.
- After a real restore, verify schema version 11, the ledger invariant, shard parity and audit chain.
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

- Secondary mirroring for Barman/Redis (WAL-G/Barman engines only): Barman returns only `primary-s3`; Redis writes only to the core prefix. The pg-native engine mirrors everything.
- Redis schedule: no `redis` cron; scheduled full/delta jobs use `target=all`, and a `delta` Redis run still performs a full BGSAVE/RDB copy.
- UTC cron: the in-process scheduler has no timezone field and evaluates UTC; the system-cron fallback uses host local time, so the historical Tripoli schedule is not honored consistently.
- Destructive-action controls: trigger/drill are not maker-checker protected.

### Resolved 2026-11-06

- Daemon certificate ownership: the deploy chowns `BACKUP_DAEMON_CERT_DIR` to the daemon user and the unit waits for readiness (see `deploy.backup`).
- Barman audit slot: `barmanStreamingSql()` creates `barman_audit` for a dedicated audit cluster (or on the core cluster when audit shares it).
- WAL archive lag: the status query no longer passes a file name to `pg_wal_lsn_diff`; lag bytes come from segment numbers.
- Retention: WAL-G prune uses `ceil(fullRetentionDays/7)` from the live policy; pg-native prunes by the live policy.
- Barman health no longer calls WAL-G.
- Catalog exposure: `admin-back` proxies `GET /catalog`.
- Audit drill role mapping: the daemon's drill now queries the audit database as `PG_AUDIT_USER` (primary role when unset), in shared and dedicated topologies.
- Archive lag no longer grows on an idle database (counted only while a completed segment waits or the archiver fails).
- Drill target: the daemon accepts an explicit `targetTime` (the default is still now minus 5 minutes).

### Known bugs / risks

- None specific to the backup control plane beyond the open gaps above.

## 10. Change history

- 2026-11-06 — Backup engine reliability implementation: `walArchiveHealthy` on the overview, `Idempotency-Key` forwarding with `deduplicated` handling, `/catalog` edge route; gaps resolved as listed above. See `deploy.backup`.

- 2026-11-03 — Initial canonical extraction. Records the core API, daemon API, WAL-G/Barman engines, UTC scheduler, JSON catalog, policy maker-checker, restore drill, catalog sync and target-aware behavior, plus the certificate ownership, audit role, Barman slot, WAL lag, retention, secondary mirroring, Redis schedule, UTC cron and Barman health gaps. See `project-design/TRACKER.md`.

## 11. Security hardening (2026-11-05)

- Off-site mirroring no longer deletes by default; set `BACKUP_SECONDARY_MIRROR_DELETE=true` to opt in.
- Admin edge backup trigger/drill calls relay a well-formed `Idempotency-Key` header to core and on to the daemon, which deduplicates retries (the edge does not require the header); policy cron is validated at the edge (see the admin edge part).
- The backup daemon authorizes its mTLS clients by certificate CN/SAN; see the backup daemon part.
