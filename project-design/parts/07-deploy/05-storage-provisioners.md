---
id: deploy.storage
title: Storage Provisioners
status: partial
confidence: high
last_verified: 2026-11-12
verified_against: d695518+working-tree
code:
  - deploy/test/testMatrix.test.ts
  - deploy/lib/converge.ts
  - deploy/provisioners/postgres18Provisioner.ts
  - deploy/provisioners/redisProvisioner.ts
  - deploy/provisioners/clamavProvisioner.ts
  - deploy/provisioners/auditAndLogDbProvisioner.ts
  - deploy/provisioners/backupEngineProvisioner.ts
  - deploy/lib/configSchema.ts
  - deploy/lib/hostPlanner.ts
  - deploy/lib/healthVerifier.ts
  - deploy/lib/quoting.ts
design_sources:
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#4-segment-3--postgresql-18-ddl-partialcoveringgin-indexes--dedicated-auditlog-schemas
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#63-individual-storage-solution-provisioners-in-deployprovisioners
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#6-ordered-14-step-multi-host-deployment-pipeline
tests:
  - deploy/test/converge.test.ts
  - deploy/stress/**
  - deploy/test/gap-hardening.test.ts
  - deploy/test/testMatrix.test.ts
  - deploy/test/provisioners.test.ts
  - deploy/test/exhaustive-deploy-matrix.test.ts
  - deploy/test/healthVerifierScale.test.ts
  - deploy/test/configScale.test.ts
  - deploy/test/security-regressions.test.ts
gaps:
  - "`DATABASE_URL` with `PGBOUNCER_ENABLED=false` connects to PostgreSQL directly without TLS and is rejected by the hostssl-only `pg_hba.conf`; Prisma's schema engine does not accept `sslmode=no-verify`, so the PgBouncer path is the only supported one until that is solved."
  - "Audit/log databases that share the primary's cluster (same host and port, e.g. everything on 5432) have one WAL stream: the core target owns `archive_command`, so the daemon's `audit_db` WAL-G target (which needs `PG_AUDIT_DATA_DIR`) has no separate WAL prefix in that topology. Backups of co-located audit data are covered by the core cluster backup only."
  - The audit/log provisioner assumes the Debian cluster names `audit` and `log`; a custom name is not configurable.
  - Storage mTLS is generated but not consumed; PostgreSQL, PgBouncer, Redis, audit and log databases do not request client certificates.
  - "PostgreSQL TLS is provisioned with a self-signed per-cluster certificate (GAP-022); there is no CA-signed server certificate or client-certificate verification, so `verify-full` is not possible yet."
  - Redis has no TLS listener.
  - PgBouncer uses `server_tls_sslmode = require` toward PostgreSQL and no client certificate (the self-signed server certificate is not verified).
  - (Superseded) WAL-G is now pinned and sha256-verified; see Security hardening. Real SHA256 values must still be supplied by the operator.
---

# Storage Provisioners

## 1. Purpose and scope

This part documents the four modular storage provisioners invoked by the deployment pipeline:

- `postgres18Provisioner.ts`: PostgreSQL 18 primary, replicas, replication slots, `pg_hba`, PgBouncer, tuning and journal partition cron;
- `redisProvisioner.ts`: Redis cache/velocity nodes;
- `clamavProvisioner.ts` (AUTO-06): ClamAV for the KYB document scan on every core host when `KYB_SCANNER_MODE=clamd` and no external `KYB_CLAMD_ADDRESS` is set. Installs `clamav-daemon` + `clamav-freshclam` (Arch: `clamav`) only when missing; writes a managed `/etc/clamav/clamd.conf` (TCP on `127.0.0.1:3310` only, local socket kept, `StreamMaxLength` and `MaxFileSize` 32M); downloads the first signature set (clamd will not start without one); disables Debian's `clamav-daemon.socket` (socket activation would own the sockets); starts clamd, or restarts it only when the configuration changed or on `--force-restart`; waits for `zPING`. The core env gets `KYB_CLAMD_ADDRESS=127.0.0.1:3310`. A host below 2 GB RAM or a failed first download (offline lab) is a warning, never a failed deploy: documents stay `PENDING` and the core's `kyb_scan_backlog` monitor check reports it. Not built: an offline signature mirror (`DatabaseMirror` is the ClamAV default) and a separate scanning host shared by several core nodes.
- `auditAndLogDbProvisioner.ts`: append-only audit database and partitioned log database;
- `backupEngineProvisioner.ts`: WAL-G/Barman archive engine, daemon environment/unit, schedules and S3/secondary target checks.

It covers what is installed, what is written, what is not consumed (especially TLS/mTLS) and the operational consequences.

It does not own the backup daemon runtime (`deploy.backup`), the host plan (`deploy.planner`), the firewall (`deploy.firewall`) or the pipeline ordering (`deploy.pipeline`).

## 2. Design intent (extracted and synthesized from ./design)

The storage plane is PostgreSQL 18 only. The design specifies:

- a tuned primary with streaming replicas initialized by `pg_basebackup -R` and physical replication slots;
- PgBouncer in transaction mode on the primary and replicas;
- SCRAM authentication and TLS-only remote database connections;
- Redis bound to the private LAN with a password and no public exposure;
- an append-only audit database with a SHA-256 hash chain and immutable rows;
- a monthly-partitioned log database with a retention function and cron;
- WAL-G or Barman for continuous WAL archiving and full/delta backups, with an S3 primary and optional secondary vault;
- journal-line partition maintenance on a daily cron;
- storage client certificates for mTLS links.

The code implements most of the topology, authentication and scheduling. The TLS/mTLS wiring is incomplete and is recorded explicitly below.

## 3. As-built architecture

### 3.1 PostgreSQL 18

`bootstrapCommands()` installs `postgresql-${PG_VERSION}`, `postgresql-contrib-${PG_VERSION}` and `pgbouncer` with `apt-get`, ensures the Debian cluster (`main` on 5432, or a named cluster on another port) exists, starts it, enables `postgresql@18-<cluster>` and PgBouncer where applicable, and creates the data directory with owner `postgres`.

The version comes from `PG_VERSION` (default `18`). The schema allows any one- or two-digit major version; there is no runtime assertion that it is exactly 18.

`postgresConfigSnippet()` writes `/etc/postgresql/<version>/<cluster>/conf.d/zz-pg-switch.conf` (where `<cluster>` is `main`, `replica_<nodeId>`, `audit` or `log`) with `listen_addresses='*'`, 300 connections, 8 GB shared buffers, 24 GB effective cache, 32 MB work memory, 1 GB maintenance memory, `io_method='io_uring'`, `synchronous_commit=on`, `wal_level=replica`, 16 WAL senders/slots, 16 GB max WAL, `pg_stat_statements` and `track_io_timing=on`.

The file contains no `ssl`, `ssl_cert_file`, `ssl_key_file`, `ssl_ca_file` or `ssl_crl_file` settings. The database listens on all interfaces and relies on UFW plus `pg_hba`.

`primaryBootstrapSql()`:

- creates the application role if absent, otherwise resets its password;
- creates the application database owned by that role if absent;
- creates the replication role with `REPLICATION LOGIN`, or resets its password;
- creates one physical replication slot per replica using a sanitized node id;
- emits a comment listing the intended `pg_hba` sources.

`pgHbaSnippet()` writes `local ... peer`, loopback `host ... scram-sha-256`, and `hostssl` all/replication lines with `scram-sha-256` for every allowed source. There is no `clientcert=verify-full` and no `cert` auth method, so the generated `pg-client` certificate is not part of database authentication.

The primary source list includes the primary itself, every replica, every core private IP, and the backup/audit/log node private IPs. The replica source list includes the primary and the backup nodes.

The provisioner writes `postgresql.conf` and `pg_hba.conf` (only when their bytes changed), **applies the cluster** (section 16: start if down, reload on change, restart only on `pending_restart`), then runs the bootstrap SQL through `runuser -u postgres -- psql -p <port>` against the now-running cluster, and installs `/etc/cron.d/pg-journal-partitions`:

```text
30 1 * * * root su - postgres -c "psql -d <PG_DB_NAME> -c 'SELECT ensure_journal_line_partitions(18)'" >/var/log/pg-journal-partitions.log 2>&1
```

The function `ensure_journal_line_partitions` must already exist from the core migrations. The same cron file is also written by the backup provisioner; the last writer wins with identical content.

### 3.2 Replicas and slots

For each replica, `replicaCommands()`:

- creates `/var/lib/postgresql` and writes `/var/lib/postgresql/.pgpass` with the replication credentials;
- stops the empty cluster, replaces its data directory with `pg_basebackup -h <primary> -p <port> -U <replicationUser> -D <dataDir> -Fp -Xs -P -R -S <slot>`, writes the slot into `postgresql.auto.conf`, starts the cluster and enables its systemd unit;
- ensures `primary_slot_name` in `postgresql.auto.conf`;
- enables and starts PostgreSQL.

The slots are created on the primary by `primaryBootstrapSql()`. Replication is asynchronous; `synchronous_commit=on` is local commit durability, not synchronous replication. There is no quorum or automatic failover.

`pg_basebackup` and the replica `.pgpass` use the replication password. The `.pgpass` is created under `/var/lib/postgresql` with a restrictive umask.

### 3.3 PgBouncer

When `PGBOUNCER_ENABLED=true`, PgBouncer is installed and configured on the primary and every replica. `/etc/pgbouncer/pgbouncer.ini` sets `listen_addr=0.0.0.0`, `listen_port=6432`, transaction pooling for the application database, `server_tls_sslmode=require`, the configured client/pool limits, reserve 10, prepared statements, SCRAM auth and `/etc/pgbouncer/userlist.txt`. The userlist contains the application and replication users with plaintext passwords, mode 0600. PgBouncer is applied by reload, or restarted only when needed (section 16).

The `[databases]` section also contains a session-scoped alias, `pgw_session`, mapping to the same real database with `pool_mode=session` and `pool_size = max(8, 2 × core nodes + 4)`. It carries the two advisory-lock consumers: the singleton-worker leader election (`LEADER_ELECTION_DATABASE_URL`) and the owner/migration URL used by `migrate deploy` and the seeders. Prisma Migrate takes a session advisory lock (`pg_advisory_lock(72707369)`); on a transaction-pooled route the lock can be left on a pooled backend and the next migration times out with P1002. The ordinary `PG_DB_NAME` entry stays transaction-pooled for application traffic. After PgBouncer is applied, the provisioner proves a login through both the application database and `pgw_session`; if the alias is not yet served after a reload, it restarts PgBouncer once and retries, so core never starts against a missing session route.

After writing both files, the provisioner resolves the service account from `systemctl show -p User --value pgbouncer` (falling back to `pgbouncer`, then `postgres`) and applies `0640` to the ini and `0600` to the userlist. This is required because Ubuntu's unit runs as `postgres` and does not create a `pgbouncer` system user; a root-owned `0640` file otherwise fails with `could not load file "/etc/pgbouncer/pgbouncer.ini": Permission denied`.

Important as-built facts:

- The `[databases]` section maps `PG_DB_NAME` to `127.0.0.1:<primaryPort>` with `PG_DB_USER` and its password, so a client connecting to `:6432` with that database name reaches the local PostgreSQL primary.
- `pgw_session` is a second alias to the same database with `pool_mode=session`; deploy writes `LEADER_ELECTION_DATABASE_URL=postgresql://…@<primary>:6432/pgw_session` into the core environment (or a direct PostgreSQL URL with `sslmode=no-verify` when PgBouncer is disabled). An explicit `LEADER_ELECTION_DATABASE_URL` in the deploy env overrides the derived value for an external database/pooler.
- The owner URL in the temporary `.env.owner` uses the same session endpoint as the leader election: the explicit `LEADER_ELECTION_DATABASE_URL` when set (including an external pooler), otherwise the deploy-managed `pgw_session` alias, otherwise the direct primary. It applies to the legacy single-role mode too; the runtime `DATABASE_URL` stays transaction-pooled, so Prisma's migration advisory lock and the seeders keep one backend for the whole session. An external pooler must allow the owner on its session route; the deploy warns when no explicit `LEADER_ELECTION_DATABASE_URL` is configured.
- `server_tls_sslmode = require` encrypts the PgBouncer-to-PostgreSQL leg; it does not verify the server certificate (`verify-full` would) and supplies no client certificate.
- There is no `client_tls_sslmode`, `client_tls_cert_file` or `client_tls_key_file`; clients are not required to present a certificate.
- `listen_addr = 0.0.0.0` is protected by UFW only; the plan opens 6432 to core sources.

The core environment points `PG_PRIMARY_PORT` and `DATABASE_REPLICA_URLS` at `PGBOUNCER_PORT` when the pooler is enabled; the generated `[databases]` mapping keeps that route working.

### 3.4 Redis

`redisProvisioner.ts` installs `redis-server`, enables it, and writes both `/etc/redis/redis.conf.d/zz-pg-switch.conf` and `/etc/redis/redis.conf` with a deduplicated private-IP + loopback bind, `protected-mode yes`, the node port, `requirepass <REDIS_PASSWORD>`, `save 3600 1`, maxmemory/policy `allkeys-lru`, no append-only file, `daemonize no`, `supervised systemd` and `dir /var/lib/pg-redis`. It writes a systemd drop-in for `redis-server` and `valkey` granting `ReadWritePaths=/var/lib/pg-redis`, runs `systemctl daemon-reload`, runs `ufw allow` for core and backup sources, restarts Redis **only if its effective config or drop-in changed (or it is down)** and verifies with `REDISCLI_AUTH=<password> redis-cli -p <port> PING`.

There is no `tls-port`, `tls-cert-file`, `tls-key-file`, `tls-ca-cert-file` or `tls-auth-clients` setting. Redis traffic is plaintext inside the private network. The generated `redis-client` certificate is unused.

### 3.5 Audit database

`auditAndLogDbProvisioner.ts` installs PostgreSQL on `AUDIT_DB_NODE` when `AUDIT_DB_MANAGE_VIA_SSH` is true, applies a minimal PostgreSQL config (`listen_addresses='*'`, `wal_level=replica`, senders/slots), writes a `pg_hba` restricted to core and backup sources (both skipped when the node is the primary's own cluster; see section 16), applies the cluster, creates the audit role/database, and applies:

- `pg_trgm`;
- `audit_records` with `seq_no` identity, UUID primary key, actor/action/entity fields, before/after JSON, `prev_hash`, `row_hash`;
- entity, actor, BRIN and trigram GIN indexes;
- `forbid_audit_mutation()` and `trg_audit_immutable` on UPDATE, DELETE and TRUNCATE;
- least-privilege grants: `SELECT, INSERT` only for the audit writer, plus sequence usage and default privileges.

The audit DDL is applied to the audit database. The `pg_hba` has the same `hostssl`-without-client-cert pattern as the core database.

### 3.6 Log database

The log provisioner installs PostgreSQL on `LOG_DB_NODE` when `LOG_DB_MANAGE_VIA_SSH` is true and applies:

- `attempt_step_logs` with a `(id, created_at)` primary key, partitioned by `RANGE (created_at)`;
- `http_access_logs` with a `(id, created_at)` primary key, partitioned by `RANGE (created_at)`;
- attempt/created indexes and BRIN indexes;
- `ensure_log_partitions(months_ahead, retention_months)`, which creates missing monthly partitions and drops partitions older than the retention cutoff;
- initial partitions six months ahead;
- `GRANT SELECT, INSERT` only for the log writer;
- `/etc/cron.d/pg-log-partitions` at `15 1 * * *` calling `ensure_log_partitions(6, <LOG_RETENTION_MONTHS>)`.

The retention function only drops partitions whose names match the monthly suffix pattern; it never drops the default partition or non-monthly tables. The log database `pg_hba` is restricted to core and backup sources and has no client-certificate requirement.

### 3.7 Backup engine provisioner

`provisionBackupEngine()` installs:

- `barman` (not for pg-native), `zstd`, `lz4`, `brotli`, `xz-utils`, `rclone`, `curl`, `ca-certificates`, and the PostgreSQL 18 client AND server packages (`postgresServerPackages()`), because the daemon runs `pg_basebackup`, `pg_receivewal`, `pg_verifybackup`, `pg_combinebackup`, `pg_dump`, `pg_restore`, `pg_ctl`, `initdb` and `psql` even on a dedicated backup host; on a host that runs no managed PostgreSQL cluster the default `postgresql` service is disabled and masked;
- WAL-G when `BACKUP_ENGINE_MODE=wal-g`: an already installed `wal-g` is reused; otherwise the pinned asset (`BACKUP_WALG_VERSION`, `BACKUP_WALG_ASSET`) is downloaded and verified against `BACKUP_WALG_SHA256` (fail closed when no checksum is supplied), then chmod +x;
- the `pgbackup` system user and `/var/lib/pg-backup`, log and cert directories;
- `/etc/pg-backup/backup.env` from `backupDaemonEnv()`;
- `/etc/pg-backup/wal-g.env` for the core target;
- the systemd unit and `/etc/cron.d/pg-backup`;
- `/usr/local/bin/pg-backup-daemon-trigger` and `/usr/local/bin/pg-backup-restore-drill`;
- Barman configuration and `.pgpass` in Barman mode;
- target reachability checks.

Archive configuration:

- WAL-G: writes `/etc/pg-backup/wal-g-core.env` on the primary and sets `archive_mode=on`, `archive_command` to `wal-g wal-push %p` with the core prefix, `restore_command` to `wal-g wal-fetch`, and `archive_timeout=60s`; the cluster is reloaded only if `postgresql.auto.conf` changed and restarted only if a setting is `pending_restart` (`archive_mode` off -> on on the first deploy).
- Barman: sets `wal_level=replica`, `archive_mode=off`, creates the `barman` slot and uses `barman-wal-archive <backupIp> <server> %p` from `streaming_archiver=on`. It writes `/etc/barman.conf` with a server section using the replication user, a `slot_name`, and `backup_method=postgres`.

The same archive configuration is applied to the audit database when `AUDIT_DB_MANAGE_VIA_SSH` is true, with `archive_command` targeting the audit prefix/server.

The provisioner also runs `verifyBackupTargetCommands()`:

- managed MinIO: `curl -fsS <BACKUP_PRIMARY_S3_ENDPOINT>/minio/health/live`; external S3 (R2/AWS/another host): any HTTP response from the endpoint (those services have no MinIO route), with an actionable error otherwise;
- an SSH `true` to the secondary target when configured;
- a non-empty encryption key check.

The MinIO health check verifies the local S3-compatible endpoint without requiring an rclone remote configuration.

### Object store provisioning and engine auto-selection (2026-11-04)

Before verification, `ensureObjectStore()` runs on the backup host:

- `BACKUP_S3_MODE` = `auto` (default) | `managed-minio` | `external`. `auto` resolves to `managed-minio` when the endpoint host is loopback, the backup node private IP or its SSH host, otherwise `external` (`resolveBackupS3Mode`).
- `external`: never touched, only verified.
- `managed-minio`: a healthy endpoint is left running; otherwise the engine installs `minio` (MinIO no longer publishes binaries and `dl.min.io` answers 410, so: an existing `minio` on the host, else `BACKUP_MINIO_BINARY_URL` (http(s):// or file://), else a source build with Go, `go install github.com/minio/minio@BACKUP_MINIO_VERSION`, several minutes; with none of these it fails with an actionable message), creates the `minio-user` account and `BACKUP_MINIO_DATA_DIR`, writes `/etc/default/minio` (0640 root:minio-user; root user/password = `BACKUP_PRIMARY_S3_ACCESS_KEY`/`SECRET_KEY`) and a `minio.service` unit, starts it, waits for health and creates the bucket from `BACKUP_PRIMARY_S3_BUCKET` (SigV4-signed `curl -X PUT`, HTTP 200/409 accepted; no `mc` needed). Install steps fail loudly: an earlier version continued past a failed download and started a unit with no binary. Loopback endpoints bind 127.0.0.1 only; others bind 0.0.0.0. Console port: `BACKUP_MINIO_CONSOLE_PORT`.
- Config validation (managed only): access key ≥3 chars, secret ≥8, bucket `s3://dns-bucket[/prefix]`, an http endpoint requires `BACKUP_S3_ALLOW_INSECURE_HTTP=true` (independent of the daemon's `BACKUP_ALLOW_INSECURE_HTTP`), https endpoints are rejected (no TLS is provisioned; use `external`).
- `BACKUP_ENGINE_MODE` defaults to `pg-native` and `auto` resolves to `pg-native` (ADR-0004): it works on the primary's host and on a dedicated backup host, needs no S3 and no external backup tool. Explicit `wal-g`/`barman` are unchanged; the rule forbidding `wal-g` on a separate host still applies to `wal-g` only.
- pg-native cluster settings (`pgNativeArchiveSql`): `wal_level=replica`, `archive_mode=on`, `archive_command = curl --fail ... --cert /etc/pg-deploy/certs/wal-archive-client.crt ... --upload-file %p https://<backup>:<port>/v1/wal/<postgres_core|audit_db>/%f`, `archive_timeout=60s`, `summarize_wal=on`, `max_wal_senders`/`max_replication_slots` raised to 10 only when below 4, `RESET restore_command`, and the replication role (`replicationRoleSql`). The provisioner checks that the `postgres` OS user can read the WAL client key and fails the deploy otherwise. Managed clusters already carry a `hostssl replication` rule for the backup node; an externally managed PostgreSQL needs it added by hand.
- `barmanStreamingSql(config, target)` creates `barman_audit` on a dedicated audit cluster (or on the core cluster when the audit database shares it), never a dangling slot on the primary.
- `BACKUP_ENGINE_MODE=auto` and `BACKUP_S3_MODE` keys are validated at load; MinIO install order and failure behaviour are described above (and in `04-pipeline.md` §13).
- The two-machine test matrix sets `BACKUP_S3_MODE=external` because it provisions its own object store.

The systemd unit runs `bun run src/index.ts` as `postgres` (WAL-G co-located with the primary) or `pgbackup` (everything else), with no `SupplementaryGroups` (which stopped systemd with status 216/GROUP on a host without a `postgres` group), `HOME`/`BUN_INSTALL_CACHE_DIR` under `/var/lib/pg-backup`, `EnvironmentFile=/etc/pg-backup/backup.env`, `ProtectSystem=strict`, `PrivateTmp=true`, `NoNewPrivileges=true`, and `ReadWritePaths` for the backup, log, catalog, cert, scratch and pgpass directories.

## 4. Contracts and invariants

- PostgreSQL 18 is the only runtime database; `DB_ENGINE` is restricted to `postgresql`.
- Application and replication roles use SCRAM passwords; replication slots are physical.
- Replicas are initialized only when the data directory is empty.
- Remote database connections use `hostssl` rules; loopback uses SCRAM without TLS.
- The audit table is append-only at the trigger and grant level.
- Log partitions are monthly; retention only affects matching monthly partitions.
- Redis is bound to the private IP plus loopback and requires a password.
- No storage provisioner writes database credentials to an edge host.
- The journal partition cron is installed on the primary and must call an existing database function.
- Backup archiving is configured on the primary/audit database, not on replicas.

## 5. Data / API / config / deployment surface

### Key configuration

| Area | Keys |
| :--- | :--- |
| PostgreSQL | `PG_MANAGE_VIA_SSH`, `PG_VERSION`, `PG_PRIMARY_NODE`, `PG_REPLICA_NODES`, `PG_SSH_*`, `PG_DB_*`, `PG_REPLICATION_*`, `PG_DATA_DIR`, `PG_AUDIT_DATA_DIR` |
| PgBouncer | `PGBOUNCER_ENABLED`, `PGBOUNCER_PORT`, `PGBOUNCER_DEFAULT_POOL_SIZE`, `PGBOUNCER_MAX_CLIENT_CONN`, `PGBOUNCER_MAX_PREPARED_STATEMENTS` |
| Redis | `REDIS_MANAGE_VIA_SSH`, `REDIS_NODES`, `REDIS_SSH_*`, `REDIS_PASSWORD`, `REDIS_MAXMEMORY`, `REDIS_URL` |
| Audit | `AUDIT_DB_MANAGE_VIA_SSH`, `AUDIT_DB_NODE`, `AUDIT_DB_SSH_*`, `AUDIT_DB_NAME`, `AUDIT_DB_USER`, `AUDIT_DB_PASSWORD` |
| Log | `LOG_DB_MANAGE_VIA_SSH`, `LOG_DB_NODE`, `LOG_DB_SSH_*`, `LOG_DB_NAME`, `LOG_DB_USER`, `LOG_DB_PASSWORD`, `LOG_RETENTION_MONTHS` |
| Backup | `BACKUP_ENABLED`, `BACKUP_NODE`, `BACKUP_ENGINE_MODE` (`pg-native` default / `wal-g` / `barman` / `auto` = `pg-native`), `BACKUP_PRIMARY_S3_*`, `BACKUP_S3_MODE`, `BACKUP_MINIO_*`, `BACKUP_CORE_S3_PREFIX`, `BACKUP_AUDIT_S3_PREFIX`, `BACKUP_SECONDARY_SSH_TARGET`, `BACKUP_FULL_CRON`, `BACKUP_DELTA_CRON`, `BACKUP_DRILL_CRON`, retention/alert keys, `BACKUP_WALG_BIN`, `BACKUP_BARMAN_BIN`, `BACKUP_BARMAN_CLOUD_BIN` |

### Generated files

- `/etc/postgresql/<version>/<cluster>/conf.d/zz-pg-switch.conf`
- `/etc/postgresql/<version>/main/pg_hba.conf`
- `/etc/pgbouncer/pgbouncer.ini`, `/etc/pgbouncer/userlist.txt`
- `/etc/redis/redis.conf`, `/etc/redis/redis.conf.d/zz-pg-switch.conf`
- `/etc/pg-backup/backup.env`, `/etc/pg-backup/wal-g.env`, `/etc/pg-backup/wal-g-core.env`, `/etc/pg-backup/wal-g-audit.env`
- `/etc/systemd/system/pg-backup-daemon.service`
- `/etc/barman.conf` and the Barman `.pgpass`
- `/etc/cron.d/pg-backup`, `/etc/cron.d/pg-log-partitions`, `/etc/cron.d/pg-journal-partitions`
- `/usr/local/bin/pg-backup-daemon-trigger`, `/usr/local/bin/pg-backup-restore-drill`
- `/etc/pg-deploy/certs/` (storage certificates, currently not consumed)

## 6. Operational usage

```bash
# Provision only the storage tier
./deploy/deploy.sh --only=pg,redis,audit-db,log-db,backup

# Or the aggregate
./deploy/deploy.sh --only=storage

# Inspect the primary
ssh <pg-primary>
sudo -u postgres psql -c 'select * from pg_replication_slots'
sudo -u postgres psql -c 'select application_name, state, sync_state from pg_stat_replication'

# Inspect PgBouncer
sudo systemctl status pgbouncer
sudo -u postgres psql -h 127.0.0.1 -p 6432 -U <user> -d <db> -c 'select 1'

# Inspect Redis
REDISCLI_AUTH='<password>' redis-cli -h <privateIp> -p <port> PING

# Inspect backup daemon
sudo systemctl status pg-backup-daemon
sudo journalctl -u pg-backup-daemon --since '1 hour ago'
```

If PgBouncer is enabled, add a `[databases]` section to `pgbouncer.ini` and reload (or, if a restart-only setting changed, restart) it before declaring the pooler usable.

## 7. Status and deviations

### Implemented

- PostgreSQL 18 installation and tuning.
- Application/replication roles, physical slots and `pg_basebackup -R` replicas.
- SCRAM `pg_hba` with `hostssl` for remote sources.
- PgBouncer installation and transaction-mode settings.
- Redis private bind, password, RDB snapshot and memory policy.
- Audit hash-chain table, immutability trigger and append-only grants.
- Log tables, monthly partitions, retention function and cron.
- WAL-G/Barman installation, archive/restore commands, daemon environment/unit, backups schedule and target checks.
- Journal and log partition cron entries.
- Storage health probes.

### Partial

- TLS is required for remote PostgreSQL connections by `hostssl`, but the provisioner does not configure the server certificate or a client-certificate requirement.
- PgBouncer is installed but has no `[databases]` mapping.
- Backup target verification depends on the MinIO endpoint and the secondary SSH target being reachable.
- WAL-G installation is unpinned.

### Missing / deferred

- Storage mTLS end to end (`ssl=on` with internal certs, `clientcert=verify-full`, Redis TLS, PgBouncer client TLS).
- Automatic failover or promotion of a replica.
- Backup restoration from the pre-migration dump.
- A PostgreSQL client package in the default bootstrap for `pg_dump`.
- `ensure_journal_line_partitions` creation in the deploy path (it assumes the core migration has run).

### Known bugs / risks

- Enabling PgBouncer points core at `:6432`, but the generated PgBouncer has no database route. This can make the deployed core unable to connect.
- The WAL-G binary URL is a moving `latest` Ubuntu 20.04 artifact; it is not checksum-verified and may not match the host distribution.
- `server_tls_sslmode=require` encrypts but does not verify the PostgreSQL server certificate.
- The Redis password is written into the config file and into `redis://` URLs in generated environments; protect those files.
- The audit/log `pg_hba` uses `hostssl` but the provisioner does not set SSL files, so the effective TLS depends on distribution defaults.
- The log retention function is destructive; a bad `LOG_RETENTION_MONTHS` can drop recent partitions.
- `listen_addresses='*'` with UFW-only protection means a firewall misconfiguration exposes the database ports.
- The backup provisioner restarts PostgreSQL only when `archive_mode` (or another postmaster setting) actually changes; that first restart can still fail and leave the cluster stopped.

## 8. Verification and tests

```bash
cd deploy && bun run typecheck && bun test test/provisioners.test.ts test/exhaustive-deploy-matrix.test.ts test/healthVerifierScale.test.ts test/configScale.test.ts
```

Covered:

- PostgreSQL tuning and `pg_hba` snippets;
- application/replication roles, slots and `pg_basebackup -R`;
- PgBouncer settings;
- Redis config and firewall commands;
- audit/log DDL and partition statements;
- backup daemon env/unit/cron/scripts;
- WAL-G/Barman command builders;
- health probe aggregation.

Not covered:

- a real PostgreSQL 18 install or replica streaming;
- a real PgBouncer connection with the generated config;
- TLS/mTLS database connections;
- a live WAL-G/Barman backup or restore;
- MinIO health and secondary-target reachability.

## 9. Source references

### Old design sections

- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` section 4, DDL.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` section 6.3, provisioners.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 9, storage and backup.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 5, firewall.

### Code paths

- `deploy/provisioners/postgres18Provisioner.ts`
- `deploy/provisioners/redisProvisioner.ts`
- `deploy/provisioners/clamavProvisioner.ts`
- `deploy/provisioners/auditAndLogDbProvisioner.ts`
- `deploy/provisioners/backupEngineProvisioner.ts`
- `deploy/lib/hostPlanner.ts`: storage env, URLs and node plans.
- `deploy/lib/healthVerifier.ts`: probes.
- `deploy/backup-daemon/src/config.ts`: daemon env contract.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/stale-claims-register.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

## 11. Multi-cluster and audit-trigger additions (2026-11-03)

- `pgClusterFor()` maps port 5432 to the Debian `main` cluster and every other role to an independent cluster (`replica_<nodeId>`, `audit`, `log`) with its own data directory, config directory, HBA and `postgresql@18-<cluster>` unit.
- Replica initialization creates the cluster first, stops it, replaces the empty data directory with `pg_basebackup -R`, then starts the cluster.
- PgBouncer is provisioned once per host and now has a `[databases]` mapping to the local PostgreSQL port.
- The audit DDL installs `pgcrypto`, the `compute_audit_chain_hash_trg` BEFORE INSERT trigger with `pg_advisory_xact_lock(994001)`, and `verify_audit_chain()` for the multi-machine matrix audit gate (`testing.multi-machine-matrix`). The trigger derives `seq_no` from the previous row under the advisory lock (2026-11-04 fix): the earlier `NEW.seq_no := nextval(...)` ran after the identity default had already consumed a value, so every insert burned two numbers and `seq_no` had gaps, which defeats gap-based deletion detection. `seq_no` is now gap-free.
- `backupDaemonEnv()` derives `PG_DATA_DIR` and `PG_AUDIT_DATA_DIR` from the real cluster names.

## 12. Cluster-aware cron and port fixes (2026-11-03)

- Journal partition cron uses the primary cluster port (`psql -p <port>`), not the default 5432.
- Log partition cron uses the log cluster port (`psql -p <port>`), so a log cluster on 5435 is maintained instead of accidentally touching the main cluster.
- Postgres bootstrap reconciles database/object ownership to `PG_DB_USER` (see `04-pipeline.md` §13).
- Backup target verification checks the MinIO health endpoint instead of an unconfigured rclone remote.

## 13. PgBouncer config ownership fix (2026-11-04)

- PgBouncer config ownership is derived from the installed systemd unit instead of assuming a `pgbouncer` user exists.
- The ownership command resolves `systemctl show -p User --value pgbouncer`, falls back to the `pgbouncer` account, then to `postgres`, and enforces `0640` on `pgbouncer.ini` plus `0600` on `userlist.txt`.
- Fixes Ubuntu hosts where `pgbouncer.service` runs as `User=postgres`; the previous `chown pgbouncer:pgbouncer ... || true` silently failed and left the config unreadable.

## 14. Redis single-machine and sandbox fixes (2026-11-04)

- `bind` addresses are deduplicated. A loopback-only node (`REDIS_NODES="...:127.0.0.1:6379"`) previously rendered `bind 127.0.0.1 127.0.0.1`; Redis bound the first socket and aborted on the duplicate with `Address already in use`.
- The provisioner writes `redis-server.service.d/zz-pg-switch.conf` and `valkey.service.d/zz-pg-switch.conf` with `ReadWritePaths=/var/lib/pg-redis`. Debian's unit uses `ProtectSystem=strict` and otherwise makes the configured `dir` read-only, so RDB saves failed with `Read-only file system`.
- The restart/health step runs `systemctl daemon-reload`, targets the configured node port, and authenticates the `PING` with `REDISCLI_AUTH` instead of an unauthenticated `redis-cli PING`.
- Before restarting, the step disables save-on-shutdown on the currently running instance (`CONFIG SET save ""`). A sandboxed instance with a read-only dir otherwise refuses to exit when its shutdown save fails, which hangs `systemctl` because Debian's unit sets `TimeoutStopSec=0`; the newly written config restores `save 3600 1`.

## 15. PostgreSQL/pooler readiness (2026-11-04)

- `applyPostgresCluster()` waits for `pg_isready` on the cluster port after every start/reload/restart.
- `provisionBackupEngine()` waits after an archive-config restart, re-applies PgBouncer (restart) only if a PostgreSQL cluster actually restarted, and waits for PgBouncer on `PGBOUNCER_PORT`. The audit target can share the primary cluster, so its restart could otherwise leave PgBouncer caching `the database system is shutting down (server_login_retry)` when the core release runs migrations through `:6432`.
- These waits prevent the core migration step from racing a PostgreSQL restart on single-machine and co-located audit deployments.

## 16. Convergence instead of restarts (2026-11-05)

**Problem (measured):** a no-op `--update` storage deploy took 4m53s. PgBouncer 1.26 handles `SIGTERM` as "wait for all clients to disconnect"; core-back keeps pooled client connections open, so `systemctl restart pgbouncer` waited out systemd's 90 s `TimeoutStopSec` and then `SIGKILL`ed it. The deploy restarted PgBouncer three times per run (PostgreSQL provisioner, then the backup provisioner twice), PostgreSQL up to three times, Redis (flushing the L2 cache and velocity counters) and the backup daemon (possibly mid-backup), all unconditionally.

**Design (`deploy/lib/converge.ts`, pure script builders; applied by the provisioners):**

- `SshRunner.writeRemoteFile()` returns whether the bytes changed (remote `cmp -s`, then `install`/atomic `mv`; the mode is re-asserted when unchanged). A runner that returns nothing (test fakes) counts as "changed".
- PostgreSQL (`applyPostgresCluster`): inactive -> `systemctl reset-failed` then `enable --now` (a failed boot leaves the unit in `start-limit-hit`, where a plain start is refused with "start request repeated too quickly"); `--force-restart` -> restart; config/hba/auto.conf changed -> `systemctl reload`, wait for `pg_conf_load_time()` to move, then restart **only if** `count(*) FROM pg_settings WHERE pending_restart` is non-zero; else nothing. Always waits for `pg_isready`. The cluster is now applied before the bootstrap SQL runs (the SQL needs a running server and uses `-p <cluster port>`).
- PgBouncer (`applyPgbouncer`): writes `pgbouncer.ini`, `userlist.txt`, the drop-in and a restart signature. The drop-in `/etc/systemd/system/pgbouncer.service.d/zz-pg-switch.conf` sets `KillSignal=SIGINT` (safe shutdown, exits in ~0.1 s with idle clients attached; verified against SIGTERM, which never exits) and `TimeoutStopSec=15s`. Down -> start; PostgreSQL restarted in this run, the restart signature (`listen_addr`, `listen_port`, `unix_socket_*`, `so_reuseport`, `pidfile`, `logfile`) changed, or `--force-restart` -> restart; any other ini/userlist change -> `reload`; else nothing.
- Redis/Valkey: the installed unit is detected from real unit files (`redis-server`, `redis`, `valkey`; a drop-in-only stub does not count). Only that flavour's config files and drop-in decide the restart, which still runs `CONFIG SET save ""` first.
- Backup daemon (`deployBackupDaemon`): rsync reports changes (`--itemize-changes`); the unit is started if down and restarted only if the source, `backup.env`, the unit or the archive environment changed. Ownership of the source tree is handed to the deploy user and back without touching `node_modules`.
- Packages: `ensurePackagesScript` installs only what is missing (`dpkg-query` / `pacman -Qq`); `apt-get update` runs only when something is missing; `pacman -Sy <pkg>` (an unsupported partial upgrade) is never used (also removed from `bootstrapPackagesCommand`); the pinned barman `pip install` is skipped when the version already matches.
- Audit/log databases whose node is the primary's own cluster (`isSameCluster`: same SSH host and service port) no longer rewrite that cluster's `postgresql.conf`/`pg_hba.conf` (the primary's source list is a superset; the two provisioners used to flip-flop the file and reload twice). Likewise the backup provisioner no longer re-points the shared cluster's `archive_command` at the `audit_db` prefix after setting the `postgres_core` one: before this change a co-located deploy left the cluster archiving WAL to `<bucket>/audit_db` and changed `archive_command` twice per run. The core target now owns the stream.
- Pooler login verification (`poolerLoginScript`): after PgBouncer is applied, the PostgreSQL provisioner proves a real login and `SELECT 1` through `:<PGBOUNCER_PORT>` (up to 45 s, private 0600 PGPASSFILE). PgBouncer caches a failed server login for `server_login_retry` (15 s), so after a database is dropped and recreated (fresh seed, restore) it answers `database "x" does not exist` and an immediately following `prisma migrate deploy` fails; the old unconditional restart hid this. Found by the destructive stress scenario.
- Latent bugs fixed on the way: the generated Arch/custom-cluster unit had `ExecReload=/bin/kill -HUP ` (the unquoted heredoc expanded `$MAINPID` to nothing, so `systemctl reload` could not work) and no `KillSignal`; replica clusters now get their config applied (they were only started); a bootstrap `psql` ran without `-p`, so a non-5432 primary would have bootstrapped the wrong cluster.

**Result on the dev box (live, same stack):** first run after the change 6.9 s (one deliberate, fast PgBouncer restart to install the drop-in), every later no-op storage run 5.1-5.4 s with every service `unchanged`; full no-op update 23 s, of which 11 s is the core release. See `testing.deploy-stress` for the repeatable proof.

## 17. Direct PostgreSQL URLs must use TLS (audit-logs 500, 2026-11-05)

**Symptom:** `GET /api/v1/admin/audit-logs` returned 500 on the admin portal while `/audit-logs/summary` returned 200. Core's audit store failed with `no pg_hba.conf entry for host "127.0.0.1", user "gw_audit_user", database "pg_audit_db", no encryption`.

**Root cause (pre-existing, not an environment problem):** commit `167aec5` (GAP-022) made `pgHbaSnippet()` emit only `hostssl` rules, but `hostPlanner` still generated `AUDIT_DATABASE_URL`, `LOG_DATABASE_URL` and `DATABASE_REPLICA_URLS` without a TLS parameter. Core's audit/log pools are plain `pg.Pool({ connectionString })`, so as soon as a deploy applied the new `pg_hba.conf` every direct connection was rejected: the audit-log list/export/detail reads, and the audit and log writers behind the same pools. Only the PgBouncer-fronted `DATABASE_URL` kept working (PgBouncer's client side is plain; it speaks TLS to PostgreSQL itself). No test tied the generated URLs to the generated `pg_hba`.

**Fix:** `directTlsQuery()` in `hostPlanner.ts` appends `?sslmode=no-verify` to those three URLs when the deploy manages the target (`PG_MANAGE_VIA_SSH`, `AUDIT_DB_MANAGE_VIA_SSH`, `LOG_DB_MANAGE_VIA_SSH`). `no-verify` is the mode node-postgres (`pg-connection-string` 2.x) maps to `ssl: { rejectUnauthorized: false }`: encrypted, certificate not verified, which is exactly the documented posture of the self-signed per-cluster certificate; `require` would reject that certificate. Externally managed databases keep the operator's URL. Regression tests (`deploy/test/converge.test.ts`) assert that the generated `pg_hba` has no non-TLS rule, that all three URLs carry the parameter for managed clusters and not for external ones, and that the parameter parses to `rejectUnauthorized: false`.

**Still open:** `DATABASE_URL` when `PGBOUNCER_ENABLED=false` goes straight to PostgreSQL without TLS and would be rejected the same way; it cannot simply take `sslmode=no-verify` because Prisma's schema engine does not understand that value. Verifying server certificates (`verify-full` with a CA-signed server certificate) remains GAP-022.

## Security hardening (2026-11-05)

- **Quoting.** Provisioners (postgres18, auditAndLogDb, backupEngine) use `deploy/lib/quoting.ts`: SQL literals are escaped, DO blocks use collision-free dollar tags, and `pgbouncer.ini`, `userlist` and `.pgpass` are escaped. `backup.env` and `wal-g.env` are rendered `KEY='value'` (a single quote in a value is rejected).
- **Credentials.** `pg_basebackup` uses `PGPASSFILE`, never `PGPASSWORD`. Bootstrap/audit/log/archive SQL lives in a private 0700 postgres-owned directory, mode 0600, removed by trap/finally.
- **WAL-G.** `restore_command` is a valid `postgresql.conf` literal (inner quotes doubled). The daemon settings `WALG_ENV_FILE`/`WALG_ENV_FILE_AUDIT` keep S3/encryption secrets out of that line; the provisioner writes `/etc/pg-backup/wal-g-core.env` and `/etc/pg-backup/wal-g-audit.env` (0640 root:postgres), so the audit restore uses the audit prefix instead of the core prefix. WAL-G is pinned (`BACKUP_WALG_VERSION=3.0.9`, `BACKUP_WALG_ASSET`) and sha256-verified fail-closed when it must be downloaded; barman is pinned (`BACKUP_BARMAN_VERSION=3.10.1`).
- **Mirror and restore.** The off-site mirror uses `rclone copy`/`rsync` without `--delete` unless `BACKUP_SECONDARY_MIRROR_DELETE=true`. The scratch restore cluster starts with `-c archive_mode=off`.
- **PostgreSQL.** `listen_addresses = 127.0.0.1,<private IP>`, de-duplicated (`postgresListenAddresses`) so a single-host install where the private IP is `127.0.0.1` emits one entry; memory settings derive from optional `PG_RAM_GB` (unset keeps 8GB/24GB/1GB); `PG_IO_METHOD` defaults to `worker` (io_uring is opt-in); an existing standby (PG_VERSION and `standby.signal` present) is not rebuilt unless `PG_REPLICA_REBUILD=true`.
- **Still open.** Real SHA256 values for WAL-G/bun/barman must be supplied by the operator (GAP-023). GAP-022 and GAP-028 are resolved (see the gap resolutions below).

## Gap resolutions (2026-11-05)

- **PostgreSQL TLS and hostssl-only (GAP-022, RESOLVED).** `postgresTlsSnippet` appends `ssl = on`, `ssl_cert_file`/`ssl_key_file` under `<cluster hba dir>/tls`, `ssl_min_protocol_version = 'TLSv1.2'` and `password_encryption = 'scram-sha-256'` to each cluster's configuration. `pgTlsCommands` idempotently creates a self-signed RSA-4096 certificate (825 days, 0600 key owned by `postgres`) on the primary and replicas unless an operator already installed one. `pgHbaSnippet` now emits only `hostssl` rules (loopback `127.0.0.1/32` and `::1/128`, every allowed source for data and replication); the plain `host` rules were removed. Replica `pg_basebackup` runs with `PGSSLMODE=require` and PgBouncer uses `server_tls_sslmode = require`.
- **Backup daemon user (GAP-022, corrected 2026-11-06; refined 2026-11-06).** `backupDaemonUser()` returns `postgres` only for WAL-G co-located with the primary (`isBackupColocatedWithPrimary`) and `pgbackup` otherwise; the earlier statement below that it returns `postgres` in WAL-G mode regardless of host is superseded. Original: `backupDaemonUser()` returns `postgres` in WAL-G mode (base backups read PGDATA and use peer auth, so a dedicated account cannot work) and `pgbackup` in Barman mode; the unit also sets `PrivateTmp=true` so the mTLS front can create its socket. Verified live: the daemon answers mTLS only (no client certificate and plain HTTP are refused) and a full WAL-G backup reaches MinIO. In Barman mode the provisioner runs the daemon systemd unit as `User=pgbackup`/`Group=pgbackup` with `SupplementaryGroups=postgres`, adds `postgres` to the `pgbackup` group, and owns `/var/lib/pg-backup`, the daemon certificate directory, the log directory, the barman state directory, `BACKUP_PGPASSFILE` and `/etc/pg-backup/wal-g.env` (`root:pgbackup`, 0640) accordingly.
- **Replica pgpass over stdin (GAP-028, RESOLVED).** `replicaPgpassContent` renders the replication `.pgpass` line and `provisionPostgres18` streams it to `/var/lib/postgresql/.pgpass` (0600) with the remote-file writer; the replication password no longer appears in any command argv. `replicaCommands` only checks and `chown`/`chmod`s the file.
- **UTC (GAP-030).** The cluster configuration also sets `timezone = 'UTC'` and `log_timezone = 'UTC'` (the engine pins its own sessions, see `core.storage`).
- **Still open.** GAP-023: real SHA256 values for WAL-G, bun and barman (`BACKUP_WALG_SHA256`, `BUN_SHA256`) must be supplied by the operator for each release.

## 18. PostgreSQL did not survive a reboot on a single Arch/Garuda host (2026-11-06)

**Symptom:** every database-backed command failed with `Transaction API error: Unable to start a transaction in the given time` (Prisma `$transaction` maxWait) while PgBouncer logged `client_login_timeout (server down)`. `systemctl status postgresql@18-*` showed `start-limit-hit`.

**Root cause (two generated-config defects, both only on the Arch/custom-cluster path):**

1. On a single-host deploy `DB_PRIVATE_IP` is `127.0.0.1`, and `postgresMainConfigSnippet` rendered `listen_addresses = '127.0.0.1,127.0.0.1'`. PostgreSQL binds the first entry, then fails the duplicate with `could not bind IPv4 address "127.0.0.1": Address already in use` and exits.
2. The generated `postgresql@18-<cluster>.service` had no `RuntimeDirectory`, and `/run` is a tmpfs, so after every reboot `/run/postgresql` did not exist and the postmaster died with `could not create lock file "/run/postgresql/.s.PGSQL.<port>.lock"`. `ensureClusterScript` only created the directory during bootstrap. The start limit then left the unit refusing further starts.

**Fix:** `postgresListenAddresses()` de-duplicates loopback + private IP (`127.0.0.1` stays a single entry); the generated unit sets `RuntimeDirectory=postgresql` and `RuntimeDirectoryMode=2775`, so systemd recreates the socket directory before every start; and `postgresApplyScript` runs `systemctl reset-failed "$unit"` before starting an inactive cluster so a start-limit from an earlier boot cannot block recovery.

**Verified live:** `./deploy/deploy.sh --update --skip-build --only=storage` brought the primary cluster, Redis and PgBouncer back (`Verification OK`); `/etc/postgresql/18/main/postgresql.conf` then had `listen_addresses = '127.0.0.1'`, the unit had `RuntimeDirectory=postgresql`, and `create-dev-users` completed against the pooler.

## Backup engine reliability (2026-11-06)

- **`pg-native` engine wiring.** `backupDaemonEnv()` emits `BACKUP_LOCAL_REPO_DIR` (pg-native), `BACKUP_WAL_CLIENT_CNS`, `PG_AUDIT_HOST` (only for a dedicated audit cluster), `PG_AUDIT_USER/_PASSWORD`, `PG_LOG_DB_NAME`, `PG_REPLICATION_USER/_PASSWORD`, `PG_REPLICATION_SLOT=pg_backup_core` and `PG_SSLMODE=require`; S3 prefixes are empty when no S3 is configured. S3 (`ensureObjectStore`, `verifyBackupTargetCommands`) is skipped when `BACKUP_PRIMARY_S3_ENDPOINT` is empty in pg-native mode, which is the air-gapped LAN setup.
- **Certificate and ownership fixes.** `uploadStorageCertificates()` chowns the daemon certificate directory to the daemon user (0750 dir, 0640 certs, 0600 keys) and `deployBackupDaemon()` uses `backupDaemonUser()` for ownership and `bun install` (run with `HOME` and `BUN_INSTALL_CACHE_DIR`), then waits up to 10 s for the unit to stay active; on failure it prints `journalctl -u pg-backup-daemon -n 40` and exits 1. Ownership under `/var/lib/pg-backup` is fixed with `find ... ! -user/-group` so a multi-terabyte local repository is not re-chowned on every deploy.
- **Lab.** `LAB_BACKUP_MODE=pg-native` selects the engine in the multi-machine lab; `BACKUP_WALG_SHA256` is only set when `LAB_WALG_SHA256` is (an all-zero checksum could never verify and aborted the install).
- **Reserved role names (fixed).** `AUDIT_DB_USER`/`LOG_DB_USER` used to default to `pg_audit_writer`/`pg_log_writer`; PostgreSQL reserves the `pg_` prefix, so `CREATE ROLE` always failed for a deployment relying on the defaults. The defaults are now `gw_audit_writer`/`gw_log_writer` and a `pg_`-prefixed value is rejected at config load.
- **More reserved defaults (found by the two-host lab).** `PG_DB_USER` and `PG_REPLICATION_USER` also defaulted to `pg_core_user`/`pg_replicator`; they are now `gw_core_user`/`gw_replicator` and all role settings (`DB_USER`, `PG_DB_USER`, `PG_REPLICATION_USER`, `AUDIT_DB_USER`, `LOG_DB_USER`) reject a `pg_` prefix.
- **Bun for the service user.** `bunInstallCommand` installs a REAL `/usr/local/bin/bun` (temp file + `mv`, so a running daemon is not hit by "text file busy") and converts an existing symlink, because a symlink into `/home/<user>/.bun` cannot be executed by the unprivileged daemon user.
- **Cron drill fallback.** `pg-backup-restore-drill` now asks the daemon for a drill for every engine (the root shell script that restored without WAL replay is removed).

## PgBouncer session alias for leader election (2026-11-07)

- The generated `[databases]` section now contains `pgw_session`, an alias to the same database with `pool_mode=session` and `pool_size=max(8, 2 × CORE_NODES + 4)`; the application database remains `pool_mode=transaction`.
- Core receives `LEADER_ELECTION_DATABASE_URL` (derived as `postgresql://…@<primary>:<PGBOUNCER_PORT>/pgw_session`; direct PostgreSQL with `sslmode=no-verify` when PgBouncer is disabled). An explicit deploy-env value overrides it.
- After `applyPgbouncer()`, the provisioner logs in through `pgw_session`; a reload normally publishes the new alias, otherwise it restarts PgBouncer once and retries. Core refuses to boot if the session endpoint is missing or transaction-pooled.
- No firewall change: the alias uses the existing `PGBOUNCER_PORT` rule from core nodes; PostgreSQL's own port remains closed to core when PgBouncer is enabled.

## Remediation round 2 (2026-11-08): role split, PgBouncer TLS, Redis

- PgBouncer authenticates each client as its own user (per-client userlist entry for `PG_APP_USER`) instead of forcing the owner, and terminates TLS on the client leg (`client_tls_sslmode`, self-signed certificate); `DATABASE_URL` carries `sslmode=no-verify` whenever the deploy manages the cluster (encrypted, not identity-verified; certificate verification remains open).
- The bootstrap SQL creates the app login role as a member of `pgw_app` with no UPDATE/DELETE/TRUNCATE on the ledger and audit tables and no DDL. Validated end to end on a TLS PostgreSQL 18 with a real PgBouncer (owner migrations, app-role privilege probes, core's Prisma client). It has not run on a multi-host lab (GAP-057 stays partial).
- Redis (`redisProvisioner.ts`): `maxmemory-policy volatile-ttl` plus AOF, so only keys with a TTL are evictable and a restart does not lose revoke flags; every durable key must carry a TTL.

## Object storage provisioner (v36)

`deploy/provisioners/objectStorageProvisioner.ts` creates the `pgobjstore`
system user, `/var/lib/pg-object-storage` and the vault subdirectories
(`hot`, `cold`, `quarantine`, `tmp`, `.trash`), writes
`/etc/pg-object-storage/object-storage.env` and
`pg-object-storage-daemon.service` (Bun, `ProtectSystem=strict`,
`PrivateTmp=true`, `ReadWritePaths` for the vault and cert directories).
`deployObjectStorageDaemon` installs pinned Bun, syncs `deploy/object-storage-daemon` to
`/opt/pg-object-storage-daemon` and starts/restarts it only on change. The
provisioner creates the user first, hands only the dedicated certificate files
to `pgobjstore`, and refuses multiple core nodes without a configured
object-storage node. Storage roots and cert directories are restricted to
`/var/lib/pg-object-storage/`.


The fresh-host sequence is tested with a fake runner; the real two-host lab remains manual.
