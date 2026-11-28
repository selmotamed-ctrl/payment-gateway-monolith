# `backup-daemon-rs` — backup control plane and restore drills (P9-T02)

Rust/ntex port of `deploy/backup-daemon/src/**`. The daemon owns the backup schedule, the
`pg-native` backup engine, the encrypted artifact repository, WAL ingest and the scratch-cluster
restore drill.

- `src/lib.rs` — modules; integration tests can call the router and every helper directly.
- `src/main.rs` — `serve`, `trigger`, `drill`, `catalog`, `wal-fetch` subcommands.
- `tests/**` — the ported TypeScript suite (see [Tests](#tests)).

## Build and run

```bash
cd backend-rs
cargo build -p backup-daemon-rs --release
target/release/backup-daemon-rs serve
target/release/backup-daemon-rs trigger --target all --kind full
target/release/backup-daemon-rs drill --latest
```

The daemon reads the environment (and `DOTENV_PATH`/`.env`) exactly like the TypeScript service.
`BACKUP_ALLOW_INSECURE_HTTP=true` is the only way to serve plain HTTP; otherwise
`BACKUP_DAEMON_CA_CERT_PATH`, `BACKUP_DAEMON_CERT_PATH` and `BACKUP_DAEMON_KEY_PATH` are required.

## HTTP contract (mTLS, default port 4090)

The peer certificate is classified before any routing: `BACKUP_ALLOWED_CLIENT_CNS` (default
`backup-client`) reaches the control plane; `BACKUP_WAL_CLIENT_CNS` (default `wal-archive-client`)
reaches **only** `PUT /v1/wal/...`. An identity in neither list gets the raw
`{"error":{"code":"forbidden","message":"client certificate is not authorized"}}` body with 403.

| Route | Role | Behaviour |
| :--- | :--- | :--- |
| `GET /health` | control | `{status, engineMode, version}` |
| `GET /v1/overview` | control | health, WAL lag, storage targets, schedule/policy, scheduler state, last 30 runs, last 10 drills, queue, `walArchive` |
| `POST /v1/backups/trigger` | control | 202 `{backupJobId, acceptedAt, queuePosition}`; `Idempotency-Key` returns `deduplicated: true`; 400 validation; 429 `queue_full` |
| `PUT /v1/policy` | control | validates five-field crons and the retention ranges; returns `{policy}` |
| `GET /v1/runs?limit=` | control | newest first, `limit` 1..500 (default 30) |
| `POST /v1/drills/run` | control | 202 `{drillId, acceptedAt, queuePosition}`; `{latest:true}` XOR `targetTime` (ISO-8601, not future) |
| `GET /v1/drills?limit=` | control | newest first |
| `PUT /v1/wal/:target/:file` | WAL | streams a WAL segment into the archive; idempotent for identical bytes; **409 `wal_conflict`** for different bytes under an existing name |

Error envelope: `{"error":{"code","message","requestId"}}`; every response carries
`x-request-id` (echoing a valid incoming value) and `cache-control: no-store`. Secrets are redacted
from every response and error (`password=...`, configured key values, credential-shaped JSON keys).

## Engines

| `BACKUP_ENGINE_MODE` | Status |
| :--- | :--- |
| `pg-native` (default, and what `auto` maps to in TS) | **Implemented** |
| `wal-g` | Explicit configuration error at startup: this build does not pretend to back up with a tool it cannot verify/restore |
| `barman` | Same explicit configuration error |

`pg-native` implements:

* full `pg_basebackup` (`--format=tar --checkpoint=fast --manifest-checksums=SHA256
  --wal-method=stream --label=... --no-password`);
* incremental `pg_basebackup --incremental=<previous backup_manifest>` with the `summarize_wal = on`
  and previous-full preconditions, and a hard refusal of non-default tablespaces **before** a backup
  is produced;
* `pg_verifybackup --format=tar --no-parse-wal`;
* a logical `pg_dump --format=custom --compress=zstd:6` companion dump for every full backup
  (`pg_restore --list` validates the archive header before it is stored);
* signed manifest written **last** (until it exists the backup does not exist), plus `walSegmentStart`
  / `walSegmentEnd` / parent chain;
* chain restore: newest verified manifest at/before the target time, walk parents to the full,
  verify each ciphertext against the signed SHA-256, decrypt + extract, `pg_combinebackup` for
  chains, extract `pg_wal.tar`, and emit `recovery_target_time` with a numeric UTC offset (the `Z`
  suffix is rejected by PostgreSQL while it reads its configuration);
* policy-driven pruning of whole backup chains plus WAL older than the oldest retained backup,
  respecting the WAL age window on the local tier;
* WAL ingest, asynchronous mirroring to non-primary tiers and reconcile-on-start.

## Storage tiers

* **Local repository** (`BACKUP_LOCAL_REPO_DIR`, default `/var/lib/pg-backup/repo` in `pg-native`) —
  implemented: atomic temp+rename writes, path confinement, `.trash`-free listing, per-tier health.
* **S3/MinIO** — `S3_NOT_CONFIGURED`: no AWS SDK is in the workspace. A configured S3 tier appears
  as an unhealthy target and any required write fails with that explicit code instead of silently
  keeping a one-copy backup.
* **Off-site SSH/rclone vault** — `SSH_VAULT_NOT_PORTED` (same fail-closed behaviour).

The catalog is mirrored to every tier as an encrypted (`PGBKv2`) and HMAC-signed copy
(`catalog/catalog.json.enc`), so a replacement host recovers runs, drills and the approved policy.

## Envelope `PGBKv2`

```
"PGBKv2" (6) | 0x02 (1) | salt (16) | iv (12) | AES-256-GCM ciphertext | tag (16)
payload key  = HKDF-SHA256(master, salt, "pg-backup-v2:payload:<target>:<id>", 32)
manifest key = HKDF-SHA256(master, "pg-backup-v2-catalog", "manifest-hmac-sha256", 32)
AAD          = header || "|<target>:<id>"
```

`BACKUP_ENCRYPTION_KEY_HEX` is the 64-hex master. Compression (`zstd`, level 6) happens **before**
encryption; `pg_dump` artifacts are not compressed twice. Drill reports are HMAC-SHA256 over stable
JSON with the raw master bytes. WAL files are stored as `wal/<target>/<file>.zst.enc`; catalog
mirror as `catalog/catalog.json.enc`; backups as `backups/<target>/<id>.tar.zst.enc` with
`backups/<target>/<id>.manifest.json`.

## Queue, idempotency, lock and scheduler

* One FIFO queue for backups **and** drills, strictly one job at a time, 25 waiting jobs by default.
* `Idempotency-Key` (1–128 chars of `[A-Za-z0-9._:-]`) scoped per route; 24 h TTL, 1000 entries,
  persisted to `<catalog dir>/idempotency-keys.json`. A restarted daemon drops keys for interrupted
  jobs so a retry runs fresh, and keeps keys for jobs that really finished.
* One daemon per state directory (`<catalog dir>/daemon.lock`, atomic `hard_link`, PID + start time,
  stale/recycled-PID takeover). A shared S3 bucket across hosts is not detected (unchanged TS gap).
* Scheduler with its own five-field cron (UTC): `fullCron`/`deltaCron`/`drillCron`, policy edits are
  picked up without a restart, and a due slot is skipped (with a warning) while any job runs.

## Restore drill

`POST /v1/drills/run` starts a scratch cluster (recovering the newest accepted backup or replaying
all WAL with `latest`), waits for promotion, then proves:

* double-entry drift: `SUM(DEBIT) - SUM(CREDIT) = 0`;
* per-shard ledger parity: balance vs all journal lines, checkpoint vs lines up to its sequence,
  gapless `shard_seq` above `baseline_seq`;
* audit hash chain: trigger canonical form (`before_json::text`/`after_json::text`) **or** the
  parsed canonical form, prev-hash link and gap-free `seq_no` (a deleted row is caught);
* object-storage manifest parity (restored ACTIVE rows vs `object-storage/active-manifest.json`)
  when a manifest was recorded; the encrypted blob/KEK decryption sample is a documented gap.

Every scratch cluster is forced to `archive_mode = off`, `archive_command = ''`, empty
`primary_conninfo`/`primary_slot_name`/`synchronous_standby_names`, `summarize_wal = off` and
`ssl = off` **before** it starts, so a promoted drill can never write into the production archive.
A missing `PG_VERSION` after a restore refuses `initdb`; only an engine that explicitly reports an
initialised empty directory may be initialised. `restore_command` calls
`backup-daemon-rs wal-fetch <target> %f %p`, which decrypts the segment from the local repository.

## Configuration (selected)

| Key | Default | Notes |
| :--- | :--- | :--- |
| `BACKUP_ENGINE_MODE` | required (`pg-native` for this build) | `wal-g`/`barman` are explicit errors |
| `BACKUP_ENCRYPTION_KEY_HEX` | required | ≥16 bytes, even hex |
| `BACKUP_COMPRESSION` | `zstd` | accepted for parity; the envelope always zstd's with the CLI |
| `BACKUP_PRIMARY_S3_ENDPOINT` / `_BUCKET` / `_ACCESS_KEY` / `_SECRET_KEY` | — | required for `wal-g`/`barman`; `S3_NOT_CONFIGURED` in this build |
| `BACKUP_LOCAL_REPO_DIR` | `/var/lib/pg-backup/repo` (`pg-native`) | tier 1 |
| `BACKUP_STAGING_DIR` / `BACKUP_WAL_SPOOL_DIR` | `/var/lib/pg-backup/{staging,wal_spool}` | scratch space |
| `BACKUP_CATALOG_PATH` | `/var/lib/pg-backup/catalog.json` | state directory owner |
| `BACKUP_FULL_CRON` / `_DELTA_CRON` / `_DRILL_CRON` | `0 2 * * 0` / `0 2 * * 1-6` / `0 4 * * 0` | UTC |
| `BACKUP_RETENTION_DAYS` equivalents | full count 8 (×7 days), WAL 14 days, alert lag 300 s | policy overrides at runtime |
| `BACKUP_DAEMON_PORT` / `_BIND_HOST` | 4090 / 127.0.0.1 | |
| `BACKUP_ALLOWED_CLIENT_CNS` / `_WAL_CLIENT_CNS` | `backup-client` / `wal-archive-client` | CN or DNS SAN |
| `BACKUP_WAL_PUSH_MAX_BYTES` / `_STREAM_ALERT_BYTES` | 64 MiB / 256 MiB | |
| `BACKUP_COMMAND_TIMEOUT_MS` / `_RECOVERY_TIMEOUT_MS` | 30 min / 10 min | every subprocess has a timeout |
| `SCHEDULER_ENABLED` / `_TICK_MS` | true / 30 s | |
| `PG_PRIMARY_HOST/PORT/USER/PASSWORD/DB_NAME` | 127.0.0.1 / 5432 / postgres / — / payment_gateway_prod | |
| `PG_AUDIT_DB_NAME` / `_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DATA_DIR` | pg_audit_db / — / 5434 / — / — / — | data dir or different host ⇒ dedicated cluster |
| `PG_REPLICATION_USER/PASSWORD/SLOT`, `PG_AUDIT_REPLICATION_SLOT` | falls back to primary | |
| `PG_REPLAY_SLOT` naming, `PG_SSLMODE` | `pg_backup_core`/`pg_backup_audit`, `prefer` | |
| `PG_DATA_DIR`, `PG_AUDIT_DATA_DIR` | `/var/lib/postgresql/18/main`, — | |
| `PG_BIN_DIR` | `/usr/lib/postgresql/18/bin` | |
| `BACKUP_SCRATCH_DIR` / `_PORT` / `_AUDIT_DIR` / `_AUDIT_PORT` | `/var/lib/pg-backup/scratch`, 55432, `<scratch>/audit`, 55433 | |
| `REDIS_URL` / `REDIS_CLI_BIN` | — / redis-cli | when set, `all` includes a Redis RDB backup |
| `OBJECT_STORAGE_DAEMON_URL` / `_KEK_KEYRING` / `_ROOT_DIR` | — | enables the object-storage manifest check |
| `WAL_FETCH_BIN` | `backup-daemon-rs` | binary named in `restore_command` |

Secrets (`BACKUP_ENCRYPTION_KEY_HEX`, S3 access/secret, all PG passwords, the object-storage KEK
keyring) are never logged, never echoed in responses and redacted from errors.

## Implemented / remaining

Implemented: mTLS control/WAL planes, all eight routes, FIFO queue + persisted idempotency, instance
lock, five-field cron scheduler, JSON catalog + encrypted signed mirror, `PGBKv2` (seal/open,
manifest HMAC, drill HMAC), `pg-native` full/incremental backups, logical dumps, `pg_verifybackup`,
chain restore with `pg_combinebackup`, policy pruning, WAL ingest/mirror/reconcile, scratch drill
with double-entry/shard/audit-chain proofs, `latest` and `targetTime`, CLI.

Remaining (documented gaps, fail closed rather than pretend):

1. **S3/MinIO tier** — `S3_NOT_CONFIGURED` (no AWS SDK dependency).
2. **Off-site SSH/rclone vault** — `SSH_VAULT_NOT_PORTED`.
3. **`wal-g` / `barman` engines** — configuration error; run the TypeScript daemon for those.
4. **Continuous `pg_receivewal` supervisor** — the archive accepts `archive_command` pushes and the
   `wal-fetch` helper, but no long-running receiver is spawned.
5. **Object-storage blob copy, KEK escrow and pgos1 decryption sample** — only the active-manifest
   parity check is ported.
6. **Streaming compression/encryption** — the TS pipeline streams; this build buffers the
   plaintext/compressed artifact because the workspace has no `zstd` crate and the `zstd` CLI works
   through files. Wire format and output bytes are identical; memory use is not.
7. **SIGTERM/`sd_notify` unit wiring** — ntex graceful shutdown is wired; the systemd `sd_notify`
   call and the deploy provisioner remain in the TS daemon task.
8. **`PGBKv2` auth-tag timing** — AES-GCM authentication is constant-time inside RustCrypto.

## Deviations from the TypeScript daemon

* `startup.ts` is a module (`startup::restore_job_state`) and used by `main`, not inlined in `index.ts`.
* Catalog mirroring is synchronous in `save()` (latest-wins) instead of scheduled; it still never
  fails a catalog write and `when_mirrored()` exists for parity.
* `JobQueue::enqueue` marks the first accepted job active before returning (same observable
  semantics as the synchronous TS drain); job bodies run in their own Tokio task so a panic cannot
  kill the queue.
* Filesystem health reports writability but not free space (`statvfs` would need another dependency).
* The instance lock uses `/proc/<pid>` for liveness/command line; `EPERM` cannot be distinguished
  without `kill(2)` (no `nix` dependency in this crate).
* `open_to_file`/`seal_file` are fully buffered (see gap 6).
* Error codes are unchanged; the WAL ingest error keeps its own code (`wal_conflict`, …).
* The object-storage drill never decrypts blobs (gap 5) but the manifest comparison is exact.
* A client that disappears mid-WAL-upload is surfaced by ntex as a transport error (logged, no
  response) rather than the TS daemon's explicit `499`; there is no peer left to answer.
* The in-flight WAL-key map and the per-idempotency-key mutex map are bounded/evicted; the WAL
  in-flight set could previously grow with every distinct segment name.

## Tests

Ported from `deploy/backup-daemon/test/**`; they use `tempfile` directories and in-memory storage
catalogs, and **no test touches a live database**:

| Rust file | TypeScript source |
| :--- | :--- |
| `tests/cron_test.rs` | `cron.test.ts` |
| `tests/config_test.rs` | `config.test.ts` |
| `tests/crypto_envelope_test.rs` | `cryptoEnvelope.test.ts` |
| `tests/command_runner_test.rs` | `commandRunner.test.ts` |
| `tests/catalog_test.rs` | `catalogStore.test.ts` + `catalogMirror.test.ts` |
| `tests/job_queue_test.rs` | `jobQueue.test.ts` |
| `tests/instance_lock_test.rs` | `instanceLock.test.ts` |
| `tests/artifacts_test.rs` | `storage.test.ts` + `repository.ts` builders |
| `tests/wal_test.rs` | `wal.test.ts` (+ `walNames`) |
| `tests/pg_native_engine_test.rs` | `pgNativeEngine.test.ts` + `backupEngine.test.ts` |
| `tests/restore_drill_test.rs` | `restoreDrillRunner.test.ts` |
| `tests/server_test.rs` | `server.test.ts` |
| `tests/scheduler_test.rs` | `scheduler.test.ts` |
| `tests/startup_test.rs` | `startup.test.ts` |
| `tests/mtls_roles_test.rs` | `mtlsAuthorization.test.ts` + role half of `mtlsRoles.test.ts` |
| `tests/object_storage_manifest_test.rs` | `objectStorageManifest.test.ts` |
| `tests/live_pg18_pitr_test.rs` | `live-pg18-pitr.test.ts` (ignored; opt-in) |

```bash
cd backend-rs
cargo test -p backup-daemon-rs
cargo clippy -p backup-daemon-rs --all-targets -- -D warnings
cargo fmt -p backup-daemon-rs -- --check
```

The live test starts a scratch cluster on a free port under a temp directory and never touches
`127.0.0.1:55432`:

```bash
BACKUP_LIVE_PG_TEST=1 cargo test -p backup-daemon-rs --test live_pg18_pitr_test -- --ignored
```
