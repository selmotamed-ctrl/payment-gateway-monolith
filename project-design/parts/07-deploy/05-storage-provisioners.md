---
id: deploy.storage
title: Storage Provisioners
status: partial
confidence: high
last_verified: 2026-11-04
verified_against: working-tree
code:
  - deploy/test/testMatrix.test.ts
  - deploy/provisioners/postgres18Provisioner.ts
  - deploy/provisioners/redisProvisioner.ts
  - deploy/provisioners/auditAndLogDbProvisioner.ts
  - deploy/provisioners/backupEngineProvisioner.ts
  - deploy/lib/configSchema.ts
  - deploy/lib/hostPlanner.ts
  - deploy/lib/healthVerifier.ts
design_sources:
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#4-segment-3--postgresql-18-ddl-partialcoveringgin-indexes--dedicated-auditlog-schemas
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#63-individual-storage-solution-provisioners-in-deployprovisioners
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#6-ordered-14-step-multi-host-deployment-pipeline
tests:
  - deploy/test/testMatrix.test.ts
  - deploy/test/provisioners.test.ts
  - deploy/test/exhaustive-deploy-matrix.test.ts
  - deploy/test/healthVerifierScale.test.ts
  - deploy/test/configScale.test.ts
gaps:
  - The audit/log provisioner assumes the Debian cluster names `audit` and `log`; a custom name is not configurable.
  - Storage mTLS is generated but not consumed; PostgreSQL, PgBouncer, Redis, audit and log databases do not request client certificates.
  - PostgreSQL SSL material is not configured by the provisioner; hostssl rules rely on the distribution's default TLS setup.
  - Redis has no TLS listener.
  - PgBouncer uses `server_tls_sslmode = prefer` and no client certificate because the deploy does not install PostgreSQL TLS material.
  - The WAL-G download uses a GitHub "latest" Ubuntu 20.04 binary URL and is not pinned or checksum-verified.
---

# Storage Provisioners

## 1. Purpose and scope

This part documents the four modular storage provisioners invoked by the deployment pipeline:

- `postgres18Provisioner.ts`: PostgreSQL 18 primary, replicas, replication slots, `pg_hba`, PgBouncer, tuning and journal partition cron;
- `redisProvisioner.ts`: Redis cache/velocity nodes;
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

The provisioner writes `pg_hba.conf`, applies the bootstrap SQL through `su - postgres`, restarts PostgreSQL, and installs `/etc/cron.d/pg-journal-partitions`:

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

When `PGBOUNCER_ENABLED=true`, PgBouncer is installed and configured on the primary and every replica. `/etc/pgbouncer/pgbouncer.ini` sets `listen_addr=0.0.0.0`, `listen_port=6432`, transaction pooling, `server_tls_sslmode=prefer`, the configured client/pool limits, reserve 10, prepared statements, SCRAM auth and `/etc/pgbouncer/userlist.txt`. The userlist contains the application and replication users with plaintext passwords, mode 0600. PgBouncer is restarted after writing it.

After writing both files, the provisioner resolves the service account from `systemctl show -p User --value pgbouncer` (falling back to `pgbouncer`, then `postgres`) and applies `0640` to the ini and `0600` to the userlist. This is required because Ubuntu's unit runs as `postgres` and does not create a `pgbouncer` system user; a root-owned `0640` file otherwise fails with `could not load file "/etc/pgbouncer/pgbouncer.ini": Permission denied`.

Important as-built facts:

- The `[databases]` section maps `PG_DB_NAME` to `127.0.0.1:<primaryPort>` with `PG_DB_USER` and its password, so a client connecting to `:6432` with that database name reaches the local PostgreSQL primary.
- `server_tls_sslmode = prefer` encrypts the PgBouncer-to-PostgreSQL leg when the server offers TLS; it does not verify the server certificate (`verify-full` would) and supplies no client certificate.
- There is no `client_tls_sslmode`, `client_tls_cert_file` or `client_tls_key_file`; clients are not required to present a certificate.
- `listen_addr = 0.0.0.0` is protected by UFW only; the plan opens 6432 to core sources.

The core environment points `PG_PRIMARY_PORT` and `DATABASE_REPLICA_URLS` at `PGBOUNCER_PORT` when the pooler is enabled; the generated `[databases]` mapping keeps that route working.

### 3.4 Redis

`redisProvisioner.ts` installs `redis-server`, enables it, and writes both `/etc/redis/redis.conf.d/zz-pg-switch.conf` and `/etc/redis/redis.conf` with a deduplicated private-IP + loopback bind, `protected-mode yes`, the node port, `requirepass <REDIS_PASSWORD>`, `save 3600 1`, maxmemory/policy `allkeys-lru`, no append-only file, `daemonize no`, `supervised systemd` and `dir /var/lib/pg-redis`. It writes a systemd drop-in for `redis-server` and `valkey` granting `ReadWritePaths=/var/lib/pg-redis`, runs `systemctl daemon-reload`, runs `ufw allow` for core and backup sources, restarts Redis and verifies with `REDISCLI_AUTH=<password> redis-cli -p <port> PING`.

There is no `tls-port`, `tls-cert-file`, `tls-key-file`, `tls-ca-cert-file` or `tls-auth-clients` setting. Redis traffic is plaintext inside the private network. The generated `redis-client` certificate is unused.

### 3.5 Audit database

`auditAndLogDbProvisioner.ts` installs PostgreSQL on `AUDIT_DB_NODE` when `AUDIT_DB_MANAGE_VIA_SSH` is true, applies a minimal PostgreSQL config (`listen_addresses='*'`, `wal_level=replica`, senders/slots), writes a `pg_hba` restricted to core and backup sources, restarts PostgreSQL, creates the audit role/database, and applies:

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

- `barman`, `zstd`, `lz4`, `brotli`, `xz-utils`, `rclone`, `curl`, `ca-certificates`;
- WAL-G when `BACKUP_ENGINE_MODE=wal-g`, by downloading `wal-g-pg-ubuntu-20.04-amd64` from the GitHub "latest" release and chmod +x;
- the `pgbackup` system user and `/var/lib/pg-backup`, log and cert directories;
- `/etc/pg-backup/backup.env` from `backupDaemonEnv()`;
- `/etc/pg-backup/wal-g.env` for the core target;
- the systemd unit and `/etc/cron.d/pg-backup`;
- `/usr/local/bin/pg-backup-daemon-trigger` and `/usr/local/bin/pg-backup-restore-drill`;
- Barman configuration and `.pgpass` in Barman mode;
- target reachability checks.

Archive configuration:

- WAL-G: writes `/etc/pg-backup/wal-g-core.env` on the primary and sets `archive_mode=on`, `archive_command` to `wal-g wal-push %p` with the core prefix, `restore_command` to `wal-g wal-fetch`, and `archive_timeout=60s`; restarts PostgreSQL.
- Barman: sets `wal_level=replica`, `archive_mode=off`, creates the `barman` slot and uses `barman-wal-archive <backupIp> <server> %p` from `streaming_archiver=on`. It writes `/etc/barman.conf` with a server section using the replication user, a `slot_name`, and `backup_method=postgres`.

The same archive configuration is applied to the audit database when `AUDIT_DB_MANAGE_VIA_SSH` is true, with `archive_command` targeting the audit prefix/server.

The provisioner also runs `verifyBackupTargetCommands()`:

- `curl -fsS <BACKUP_PRIMARY_S3_ENDPOINT>/minio/health/live`;
- an SSH `true` to the secondary target when configured;
- a non-empty encryption key check.

The MinIO health check verifies the local S3-compatible endpoint without requiring an rclone remote configuration.

The systemd unit runs `bun run src/index.ts` as `pgbackup` with `EnvironmentFile=/etc/pg-backup/backup.env`, `ProtectSystem=strict`, `NoNewPrivileges=true`, and `ReadWritePaths` for the backup, log, catalog, cert, scratch and pgpass directories.

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
| Backup | `BACKUP_ENABLED`, `BACKUP_NODE`, `BACKUP_ENGINE_MODE`, `BACKUP_PRIMARY_S3_*`, `BACKUP_CORE_S3_PREFIX`, `BACKUP_AUDIT_S3_PREFIX`, `BACKUP_SECONDARY_SSH_TARGET`, `BACKUP_FULL_CRON`, `BACKUP_DELTA_CRON`, `BACKUP_DRILL_CRON`, retention/alert keys, `BACKUP_WALG_BIN`, `BACKUP_BARMAN_BIN`, `BACKUP_BARMAN_CLOUD_BIN` |

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

If PgBouncer is enabled, add a `[databases]` section to `pgbouncer.ini` and restart it before declaring the pooler usable.

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
- The backup provisioner restarts PostgreSQL after changing `archive_command`; a failure can leave the cluster stopped.

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

- `provisionPostgres18()` waits for `pg_isready` on the primary port after restarting PostgreSQL.
- `provisionBackupEngine()` waits after the core and audit archive restarts, restarts PgBouncer after the last PostgreSQL restart, and waits for PgBouncer on `PGBOUNCER_PORT`. The audit target can share the primary cluster, so its restart could otherwise leave PgBouncer caching `the database system is shutting down (server_login_retry)` when the core release runs migrations through `:6432`.
- These waits prevent the core migration step from racing a PostgreSQL restart on single-machine and co-located audit deployments.
