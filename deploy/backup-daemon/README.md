# pg-backup-daemon

Backup and point-in-time-recovery (PITR) control plane for the PostgreSQL 18
storage tier. It takes full and incremental backups, archives WAL continuously,
keeps an encrypted multi-tier repository, owns the full/delta/drill schedule,
exposes an mTLS HTTP API and proves every backup with scratch-cluster restore
drills that check the ledger and audit invariants.

It is not a PostgreSQL provisioner and it is not the approval workflow. The
deploy engine configures the cluster, archiving and certificates; `core-back`
owns the admin-facing proxy and the maker-checker policy approval.

## 1. Engines

`BACKUP_ENGINE_MODE` selects one of three engines. They share the scheduler, the
catalog, the HTTP API, the job queue and the restore drill.

| Engine | Where it can run | What it needs | Notes |
| :--- | :--- | :--- | :--- |
| `pg-native` | Same host as the primary **or** a dedicated backup host | PostgreSQL 18 client tools, `zstd`, `tar` | No external backup tool. Uses the PostgreSQL replication protocol, so it behaves identically in both topologies. S3 is optional. |
| `wal-g` | Same host as the primary only (reads `PGDATA`, peer auth as `postgres`) | `wal-g`, S3/MinIO | Daemon runs as `postgres`. |
| `barman` | Dedicated backup host | `barman`, `barman-cloud-backup`, S3/MinIO | Retention is applied by Barman. |

The deploy keeps `BACKUP_ENGINE_MODE=auto` resolving to `wal-g` (co-located) or
`barman` (separate host). `pg-native` is selected explicitly.

### 1.1 pg-native

```text
 PostgreSQL primary (+ pg_audit_db)                   pg-backup-daemon
 ┌────────────────────────────┐                ┌───────────────────────────────────┐
 │ replication protocol  ─────┼──────────────▶ │ pg_basebackup (full / incremental)│
 │ (pg_basebackup,            │                │ pg_receivewal  (continuous WAL)   │
 │  pg_receivewal, slot)      │                │ pg_dump -Fc    (logical)          │
 │                            │                │ pg_verifybackup --no-parse-wal    │
 │ archive_command = curl ────┼── mTLS PUT ──▶ │ PUT /v1/wal/:target/:file         │
 └────────────────────────────┘                └──────────────┬────────────────────┘
                                                              │ tar → zstd → AES-256-GCM
                                       ┌──────────────────────┼─────────────────────┐
                                       ▼                      ▼                     ▼
                                Tier 1 local repo      Tier 2 S3/MinIO       Tier 3 off-site vault
                                (instant restore)      (optional)            (append-only)
```

**Backups**

- **Full** (`pg_basebackup --format=tar --wal-method=stream --manifest-checksums=SHA256`):
  verified with `pg_verifybackup --format=tar --no-parse-wal` (tar-format
  verification cannot parse WAL; the restore drill proves the WAL), then packed
  `tar → zstd -6 → AES-256-GCM` and stored on every tier.
- **Logical dump** (`pg_dump --format=custom --compress=zstd:6`) of the core and
  audit databases with every full backup; checked with `pg_restore --list`.
- **Delta** (`pg_basebackup --incremental=<parent backup_manifest>`, PostgreSQL 17+):
  requires `summarize_wal = on` and a previous verified backup of the target. A
  delta **fails loudly** rather than silently becoming a full backup.
- A backup's signed manifest is written **last**; until it exists the backup does
  not exist. A failed run removes everything it wrote.
- Redis (`redis` target) is dumped with `redis-cli --rdb` and stored encrypted in
  the repository.

**Continuous WAL (two paths, de-duplicated)**

1. `pg_receivewal --synchronous` against a persistent replication slot, supervised
   with restart/backoff. Completed segments are encrypted into the repository and
   removed from the private spool; the `.partial` segment stays so recovery can
   use even the newest WAL.
2. The database's `archive_command` pushes each completed segment over mTLS
   (`curl --upload-file`) to `PUT /v1/wal/:target/:file` using the dedicated
   `wal-archive-client` certificate. The database host needs no S3 credentials.

Storing the same bytes twice is acknowledged (idempotent); different bytes for an
existing name are refused with **409** and never overwrite the archive. WAL is
acknowledged once it is on the first tier; the other tiers are mirrored
asynchronously with retry and a periodic reconcile pass.

**Restore** (`recover`): picks the newest verified backup that finished at or
before the target time, resolves its chain back to a full backup, fetches each
artifact from the first tier whose copy matches the signed SHA-256 (a bit-rotted
local copy falls through to S3 or the vault), decrypts and extracts it, runs
`pg_combinebackup` for chains, and returns a recovery fragment whose
`restore_command` is `bun src/walFetchCli.ts <target> %f %p`. The restore command
reads the daemon's environment, which the scratch PostgreSQL inherits.

**Retention** follows the *live* maker-checker policy (`fullRetentionDays`,
`walRetentionDays`), not the boot-time environment: whole backup chains older than
the window are removed with their artifacts and logical dumps; the newest full
backup is never removed; WAL older than the first segment needed by the oldest
retained full backup (and older than the WAL window) is removed; timeline history
files are kept. Delta pruning is non-destructive.

### 1.2 Cluster topology

The audit database either lives **inside the primary cluster** (shared) or in its
own cluster (dedicated). `isAuditDedicatedCluster()` is true when
`PG_AUDIT_DATA_DIR` is set or `PG_AUDIT_HOST` differs from `PG_PRIMARY_HOST`.
`PG_AUDIT_PORT` is deliberately not part of the decision (it defaults to 5434).

| | Shared | Dedicated |
| :--- | :--- | :--- |
| `postgres_core` | physical backup (contains both databases) | physical backup of the primary |
| `audit_db` | **logical dump** + signed manifest, never needs `PG_AUDIT_DATA_DIR` | physical backup of the audit cluster + dump |
| `target=all` | core, audit dump (skipped if the audit DB does not exist), redis if configured | core, audit, redis if configured |
| Restore drill | one scratch cluster | two scratch clusters |

This applies to all three engines.

### 1.3 WAL-G and Barman specifics

- **WAL-G** talks to PostgreSQL over the local socket as `postgres` (peer auth).
  It must **not** be pointed at `PG_PRIMARY_HOST`/`PG_PRIMARY_USER`: that is the
  application role, which cannot start a backup. A shared-cluster audit database
  is backed up with a logical dump; `prune` uses `retain FULL <ceil(days/7)>`
  from the live policy.
- **Barman** health checks `barman check` for core (and audit only for a dedicated
  cluster) and proves the object store with the daemon's own S3 client. It never
  calls `wal-g`. Retention is applied server-side by Barman.

## 2. Security model

**Encryption envelope** (`src/cryptoEnvelope.ts`): every artifact and WAL file is
`"PGBKv2" | version | salt(16) | iv(12) | AES-256-GCM ciphertext | tag(16)`.
The payload key is `HKDF-SHA256(master, salt, "pg-backup-v2:payload:<target>:<id>")`;
the header and `<target>:<id>` are bound as GCM additional data, so ciphertext
cannot be moved to another artifact. Compression happens before encryption.
Decryption fails closed on any modification (body, IV, salt, tag, magic,
truncation, appended bytes, wrong key, wrong target/id) and never leaves partial
plaintext behind.

**Signed manifests**: `<backupId>.manifest.json` carries LSNs, WAL segment range,
parent backup, sizes, `sha256` of plaintext and ciphertext, encryption metadata,
`pg_verifybackup` result and storage tiers, signed with HMAC-SHA256 under
`HKDF(master, "pg-backup-v2-catalog", "manifest-hmac-sha256")`. A manifest that
does not verify is ignored by restore and retention.

**Catalog mirroring**: every catalog save uploads an encrypted, signed copy
(`catalog/catalog.json.enc`) to each tier. A replacement host with no local
catalog recovers runs, drills and the approved policy from it, and rebuilds run
history from manifests when no copy exists.

**mTLS roles.** The public listener is a `node:tls` server (Bun's `node:https`
does not expose `getPeerCertificate()`), which classifies the client certificate
and bridges the connection to a per-role inner listener:

| Client certificate CN | Role | Reaches |
| :--- | :--- | :--- |
| in `BACKUP_ALLOWED_CLIENT_CNS` (default `backup-client`) | `control` | every route **except** WAL upload |
| in `BACKUP_WAL_CLIENT_CNS` (default `wal-archive-client`) | `wal` | **only** `PUT /v1/wal/...` |
| anything else | - | `403` |

The WAL client certificate lives on the database hosts, so a compromised database
host can push WAL but cannot read the catalog, change the policy or trigger jobs.
Keep the two lists disjoint.

## 3. Job queue and idempotency

All long-running work (HTTP backups, HTTP drills, scheduled slots) goes through
one FIFO queue (`src/jobQueue.ts`): jobs run strictly one at a time in acceptance
order, so two clicks on "Run backup now" can never start overlapping
`pg_basebackup` / `pg_ctl` processes. A scheduled slot that finds the queue busy
is skipped with a warning.

`Idempotency-Key` (1-128 chars of `[A-Za-z0-9._:-]`) on a trigger or drill returns
`202` with the **original** job id and `deduplicated: true` instead of queueing a
second job. Keys are scoped per route and expire after 24 h. They are persisted to
`<catalog dir>/idempotency-keys.json`; after a restart only keys of jobs that really
finished are restored, runs the dead process left `QUEUED`/`RUNNING` are marked
`FAILED (interrupted)`, and an interrupted job's key is dropped so a retry starts a
fresh job. A pid lock (`<catalog dir>/daemon.lock`) refuses a second daemon on the
same state directory. A full queue (25 waiting) answers `429` and leaves a
`FAILED` run row rather than a phantom `QUEUED` one.

## 4. HTTP API

| Method | Path | Role | Notes |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | control | Liveness, engine mode, version. Does not run engine checks. |
| `GET` | `/v1/overview` | control | Engine health, WAL lag, targets, policy/schedule, scheduler state, `jobs` (`active`, `queued`), `walArchive` (pg-native), recent runs and drills. |
| `POST` | `/v1/backups/trigger` | control | `{ target, kind, requestedBy? }` → `202 { backupJobId, acceptedAt, queuePosition }`. |
| `POST` | `/v1/drills/run` | control | `{ requestedBy?, targetTime? }` → `202 { drillId, acceptedAt, queuePosition }`. `targetTime` is ISO-8601 and not in the future; default is now − 5 minutes. |
| `PUT` | `/v1/policy` | control | Full policy object (not a patch). No maker-checker here; core adds it. |
| `GET` | `/v1/runs?limit=`, `/v1/drills?limit=` | control | 1-500. |
| `PUT` | `/v1/wal/:target/:file` | wal | Raw body ≤ `BACKUP_WAL_PUSH_MAX_BYTES` (64 MiB). `target` is `postgres_core` or `audit_db`; `file` is a 24-hex segment, `<8hex>.history` or `<24hex>.<8hex>.backup`. `200 { status: "stored" \| "duplicate" }`, `409` on conflict, `413`/`400` on bad input, `501` on engines without WAL ingest. |

Bodies other than WAL are capped at 256 KiB. Responses use `cache-control: no-store`,
`x-request-id` and recursive credential redaction. Errors use
`{ error: { code, message, requestId } }`.

## 5. WAL health

`pg_stat_archiver.last_archived_wal` is a segment **file name**, not an LSN. The
status query returns it as text and the byte lag is computed from segment numbers
(`src/walNames.ts`); it is never passed to `pg_wal_lsn_diff()`. Lag is
only reported while archiving is genuinely behind: a COMPLETED segment is waiting
(current segment > last archived + 1) or the archiver is failing, so an idle
database (no WAL) does not alarm; the segment being written is not late.

## 6. Restore drill

`src/restoreDrillRunner.ts`:

1. `targetTime` = the requested time or now − 5 minutes; stop and clear scratch.
2. `engine.recover()` for the core cluster (and the audit cluster only when dedicated).
3. Make the data directory startable: a physical backup holds `PGDATA` only, and
   Debian-style clusters keep `postgresql.conf`/`pg_hba.conf` outside it, so a
   minimal config is generated, sized from `pg_controldata` (hot standby refuses to
   start below the primary's `max_connections` and friends).
4. Append recovery settings **and force archiving off** (`archive_mode=off`,
   `archive_command=''`, no replication slot/standby names, `ssl=off`). The
   restored `postgresql.auto.conf` contains the production `archive_command`;
   without this a promoted scratch cluster pushes its own timeline into the
   production archive and breaks every later restore.
5. Start on loopback and **wait for recovery to finish and promote**
   (`pg_is_in_recovery() = f`, up to `BACKUP_RECOVERY_TIMEOUT_MS`); `pg_ctl -w start`
   returns as soon as read-only connections are accepted. A failed start includes
   the tail of the server log in the report.
6. Run exactly three checks: double-entry zero drift, sharded balance parity, and
   the audit hash chain. Audit queries run as `PG_AUDIT_USER` (the primary role when
   unset): only that role is granted on the audit database.
7. Sign the report (HMAC-SHA256) and destroy the scratch cluster in `finally`.

The **audit chain** is verified against what the database trigger actually hashed
(`before_json::text` / `after_json::text`, with the timestamp formatted as the
trigger formats it) or the application's stable-JSON form, and `seq_no` must be
gap-free so a deleted row is detected. In a shared cluster the audit database
comes back inside the physical restore; if it does not, the newest logical dump is
restored into the same scratch cluster.

## 7. Environment contract

`src/config.ts` is the source of truth; unknown keys are ignored. Boolean values
accept `true`, `1`, `yes`, `on`. Empty strings count as unset.

### Engine, storage and encryption

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `BACKUP_ENGINE_MODE` | required | `pg-native`, `wal-g` or `barman`. |
| `BACKUP_ENCRYPTION_KEY_HEX` | required | Hex, ≥ 16 bytes, even length (the deploy requires 64 hex chars). Encrypts artifacts, signs manifests, catalog and drill reports. |
| `BACKUP_COMPRESSION` | `zstd` | WAL-G/Barman compression. (pg-native always uses zstd.) |
| `BACKUP_LOCAL_REPO_DIR` | `/var/lib/pg-backup/repo` for pg-native, empty otherwise | Tier 1 local repository. |
| `BACKUP_PRIMARY_S3_ENDPOINT`, `BACKUP_PRIMARY_S3_BUCKET` | required for wal-g/barman, optional for pg-native | Tier 2. Provide both or neither. Bucket may be `s3://bucket/prefix`. |
| `BACKUP_PRIMARY_S3_ACCESS_KEY`, `BACKUP_PRIMARY_S3_SECRET_KEY` | empty | Provide both or neither. |
| `BACKUP_CORE_S3_PREFIX`, `BACKUP_AUDIT_S3_PREFIX` | `<bucket>/postgres_core`, `<bucket>/audit_db` | WAL-G/Barman prefixes. |
| `BACKUP_SECONDARY_SSH_TARGET` | empty | Tier 3: `user@host:/path` (rsync + remote `sha256sum`), `s3://...` or `rclone:` target. |
| `BACKUP_SECONDARY_MIRROR_DELETE` | `false` | `true` lets the vault delete; the default is append-only. |
| `BACKUP_WAL_SPOOL_DIR` | `/var/lib/pg-backup/wal_spool` | Private (0700) plaintext spool for `pg_receivewal`. |
| `BACKUP_STAGING_DIR` | `/var/lib/pg-backup/staging` | `pg_basebackup`/`pg_combinebackup`/`pg_dump` working area. |
| `BACKUP_WAL_STREAMING_ENABLED` | `true` | Run `pg_receivewal` (pg-native). |
| `BACKUP_STREAM_ALERT_BYTES` | `268435456` | The WAL stream is unhealthy once this many bytes behind the primary (from the replication slot). |
| `BACKUP_WAL_PUSH_MAX_BYTES` | `67108864` | Cap for `PUT /v1/wal`. |
| `BACKUP_COMMAND_TIMEOUT_MS` | `1800000` | Timeout for a single external command. |
| `BACKUP_RECOVERY_TIMEOUT_MS` | `600000` | How long a drill waits for WAL replay to finish and promote. |

### Schedule, retention, alerts

`BACKUP_FULL_CRON` (`0 2 * * 0`), `BACKUP_DELTA_CRON` (`0 2 * * 1-6`),
`BACKUP_DRILL_CRON` (`0 4 * * 0`), `BACKUP_RETENTION_FULL_COUNT` (`8`, seeds the
default policy as `count × 7` days), `BACKUP_RETENTION_WAL_DAYS` (`14`),
`BACKUP_ALERT_LAG_SECONDS` (`300`), `SCHEDULER_ENABLED` (`true`),
`SCHEDULER_TICK_MS` (`30000`). Cron is strictly five fields. After the first start
the live policy (changed through core's maker-checker) governs.

### Listener and mTLS

`BACKUP_DAEMON_PORT` (`4090`), `BACKUP_DAEMON_BIND_HOST` (`127.0.0.1`),
`BACKUP_DAEMON_CERT_PATH` / `_KEY_PATH` / `_CA_CERT_PATH` (required together
unless `BACKUP_ALLOW_INSECURE_HTTP=true`, which is development only),
`BACKUP_ALLOWED_CLIENT_CNS` (`backup-client`), `BACKUP_WAL_CLIENT_CNS`
(`wal-archive-client`).

### PostgreSQL

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `PG_PRIMARY_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DB_NAME` | `127.0.0.1` / `5432` / `postgres` / empty / `payment_gateway_prod` | Primary. |
| `PG_AUDIT_DB_NAME` | `pg_audit_db` | Audit database. |
| `PG_AUDIT_HOST`, `PG_AUDIT_USER`, `PG_AUDIT_PASSWORD` | unset | Set when the audit database is on a different host/role (see 1.2). |
| `PG_AUDIT_PORT` | `5434` | Port of a dedicated audit cluster. |
| `PG_AUDIT_DATA_DIR` | unset | Dedicated audit cluster data directory (also marks it dedicated). |
| `PG_LOG_DB_NAME` | unset | Log database name (topology helper). |
| `PG_REPLICATION_USER`, `PG_REPLICATION_PASSWORD` | primary role | Role for `pg_basebackup` / `pg_receivewal`. |
| `PG_REPLICATION_SLOT`, `PG_AUDIT_REPLICATION_SLOT` | `pg_backup_core`, `pg_backup_audit` | Persistent slots for continuous WAL. |
| `PG_SSLMODE` | `prefer` | `PGSSLMODE` for daemon connections (the deploy sets `require`). |
| `PG_DATA_DIR` | `/var/lib/postgresql/18/main` | Used by WAL-G. |
| `PG_BIN_DIR` | `/usr/lib/postgresql/18/bin` | `psql`, `pg_basebackup`, `pg_ctl`, ... |
| `PG_REPLICA_NODES` | empty | First entry feeds WAL-lag health. |
| `WALG_BIN`, `BARMAN_BIN`, `BARMAN_CLOUD_BIN`, `BARMAN_SERVER`, `BARMAN_AUDIT_SERVER`, `WALG_ENV_FILE`, `WALG_ENV_FILE_AUDIT` | | Engine-specific. |

### Catalog, scratch, Redis

`BACKUP_CATALOG_PATH` (`/var/lib/pg-backup/catalog.json`; delta manifests live in a
`manifests/` directory beside it), `BACKUP_SCRATCH_DIR` (`/var/lib/pg-backup/scratch`),
`BACKUP_SCRATCH_PORT` (`55432`), `BACKUP_SCRATCH_AUDIT_DIR`,
`BACKUP_SCRATCH_AUDIT_PORT` (`55433`, dedicated only), `REDIS_URL`, `REDIS_CLI_BIN`.

Keep the scratch directory path short: PostgreSQL's Unix socket path limit is 107
bytes and the drill places the socket in the scratch directory.

## 8. Deploy-generated environment and unit

`deploy/provisioners/backupEngineProvisioner.ts` writes `/etc/pg-backup/backup.env`
from `deploy/deploy.env` and the systemd unit; `deploy/deploy.ts` syncs this
directory to `/opt/pg-backup-daemon`. `backup.env.example` is a
local/troubleshooting reference only.

The unit runs as `postgres` only for WAL-G co-located with the primary, otherwise
as `pgbackup`; it sets `HOME` and `BUN_INSTALL_CACHE_DIR` under `/var/lib/pg-backup`
and no longer forces a `postgres` supplementary group (which stops systemd on a
host without that group). The deploy chowns the certificate directory to the daemon
user and waits for the unit to stay active, printing `journalctl` on failure.

## 9. Operations

```bash
cd deploy/backup-daemon
bun install
bun run start            # development: set BACKUP_ALLOW_INSECURE_HTTP=true
bun run typecheck
bun test                 # includes the live PostgreSQL test when the binaries exist
```

`test/live-pg18-pitr.test.ts` runs a private throwaway cluster under `/tmp` on free
ports and exercises the whole path (see the project design part
`deploy.backup`). It skips with a message when `initdb`, `pg_basebackup`,
`pg_combinebackup`, `zstd`, `curl`, `tar` or `openssl` are missing.

Deployed service:

```bash
systemctl status pg-backup-daemon
journalctl -u pg-backup-daemon --since '1 hour ago'
```

mTLS calls use the `backup-client` certificate:

```bash
CERT_DIR=/var/lib/pg-backup/shared/certs
curl -fsS --cacert "$CERT_DIR/internal-ca.crt" --cert "$CERT_DIR/backup-client.crt" \
  --key "$CERT_DIR/backup-client.key" "https://$HOST:4090/v1/overview"

curl -fsS --cacert "$CERT_DIR/internal-ca.crt" --cert "$CERT_DIR/backup-client.crt" \
  --key "$CERT_DIR/backup-client.key" -H 'content-type: application/json' \
  -H 'Idempotency-Key: manual-2026-11-06-1' -X POST \
  --data '{"target":"all","kind":"full"}' "https://$HOST:4090/v1/backups/trigger"
```

## 10. Two-host lab

`test/lab/two-host.lab.test.ts` runs the primary on this machine and the daemon alone on a second machine
as a systemd service (user `pgbackup`, no PostgreSQL server there). Credentials come only from the environment:

```bash
LAB_B_HOST=10.0.0.5 LAB_B_USER=ops LAB_B_PASSWORD=... bun test test/lab/two-host.lab.test.ts
```

It needs the PostgreSQL 18 packages, bun, zstd, curl, tar, rsync and sudo on host B, and the PostgreSQL
binaries (plus optional pgbench) on host A. `LAB_KEEP=1` leaves host B provisioned. It opens the daemon
port in host B's ufw to host A only and removes the rule afterwards. It checks provisioning, mTLS, full and
incremental backup, WAL by both paths, restore drills on B while the primary keeps committing, and a total
loss of the primary recovered from B alone.

## 11. Known limits

- The log database is not a backup target.
- The `pg-native` engine passed the two-host lab (section 10) on one pair of machines;
  WAL-G and Barman have not run on two hosts and the lab is manual (not in CI).
- The job queue is per daemon process and the pid lock covers one state directory on
  one host; two daemons on different hosts sharing one bucket are not detected.
- `pg_verifybackup` cannot parse WAL in tar mode; WAL correctness is proven by the
  restore drill, not at backup time.
- Only the default tablespace layout is supported: a cluster with extra tablespaces is
  refused at backup time instead of producing a backup that cannot be restored.
