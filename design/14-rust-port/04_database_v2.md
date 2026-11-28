# Chapter 4 — Database Architecture v2

> Part of the Rust/ntex port plan (`porting_to_ntex_rust.md`). Review of the current PostgreSQL 18 design and the
> target design, split into **S-DB** items (compatible with the running TS code; applied during coexistence) and
> **E-DB** items (applied after the TS backend is retired). Evidence paths: `S` = `core-back/prisma/schema.prisma`,
> `M/<prefix>` = `core-back/prisma/migrations/<prefix>…/migration.sql`, `P18` =
> `deploy/provisioners/postgres18Provisioner.ts`, `ALP` = `deploy/provisioners/auditAndLogDbProvisioner.ts`.

---

## 1. Which track an improvement belongs to

| Test | Track |
| :--- | :--- |
| Invisible to TS code (new index, server setting, DEFAULT, trigger producing values TS would also produce, new role TS does not use) | **S-DB** |
| Visible to TS but TS can be patched in a small, reviewed change that lands before or with the DB change (e.g. retention calls a function instead of `DELETE`) | **S-DB** (TS patch + DB change in one release) |
| Changes column types, splits tables, moves data, requires every query to set session state (RLS), changes encryption formats | **E-DB** |

Every S-DB migration must keep the TS core working on the new schema **and** the previous Rust release working
(N-1 compatibility, §8.1).

---

## 2. Current design: findings that drive the redesign

### 2.1 Security

1. **Audit tampering by the app role** — `pgw_reject_audit_log_mutation` allows DELETE whenever the session sets
   `pgw.audit_retention='on'` (`M/20261105090000:69-73`); any session can set a custom GUC and `pgw_app` still holds
   DELETE on `audit_log` (`:149`). Confirmed 2026-11-28.
2. **Plaintext customer identifiers** — `payment_attempts.customer_fields_masked` stores phone, IP, card alias,
   device fingerprint, wallet id and arbitrary customer fields unmasked (`core-back/engine/guards/AttemptGuardPipeline.ts:754-761`).
3. **Plaintext bank details and contact PII** — `merchants.payout_bank_details_json`, `cashout_requests.destination_bank_json`,
   `merchants.contact_*`, `support_*`, `tax_id`, `registration_no` (trigram-indexed, `M/20261103180000:151-162`),
   `users.email/phone`, `beneficial_owners.full_name_*`, `date_of_birth`, `audit_*` `actor_email`/`client_ip`.
4. **No Row Level Security**; tenant isolation is application-only and `requireMerchantScope` fails open on null
   `merchantId` (`core-back/api/middleware/authDoubleCheck.ts:450-452`).
5. **App may run as owner** when `PG_APP_PASSWORD` is unset (`deploy/lib/configSchema.ts:803-810`); PgBouncer userlist
   includes the owner (`P18:543-546`).
6. **No read-only reporting role**: report executors fall back to `DATABASE_URL`; protection is a READ ONLY
   transaction plus a regex blocklist (`PostgresReadOnlyExecutor.ts:101,155`).
7. **TLS unverified**: self-signed per-cluster certs, clients use `sslmode=no-verify` (`hostPlanner.ts:363-368`);
   `hostssl replication all` open to core/backup/audit/log IPs, not just replicas (`P18:358-369,685-694`).
8. **Vault AAD = keyId only** (`Vault.ts:285`): ciphertexts can be swapped between rows/columns.
9. Audit/log DB writer roles own their databases (`ALP:337`).

### 2.2 Performance and scalability

1. `payment_attempts` has **25 indexes** and two row triggers on every insert/update (health markers; plane fence
   doing a `SELECT` per row); redundant: `(merchant_id, created_at)` ⊂ `merchant_keyset_cov`, `(status,
   next_check_at)` overlaps `active_poll_partial`, low-selectivity `(status, created_at)`, FK-only `gateway_version_id`.
   Velocity rules filter on `client_ip` and JSON paths with no index (`AttemptGuardPipeline.ts:1307-1320`).
2. Queue tables (`outbox_events`, `audit_outbox`, `background_jobs`, `notifications`, `merchant_webhook_deliveries`,
   `inbound_events`) are plain heaps cleaned by `DELETE` (or never: `background_jobs`, `merchant_webhook_deliveries`);
   `outbox_events` partial index omits `parked_at`; no per-table autovacuum tuning on most.
3. Retention deletes scan sequentially (`notifications.created_at`, `inbound_events.received_at`,
   `attempt_step_logs.created_at`; `RetentionWorker.ts:236-276`).
4. Audit DB chain trigger serialises **every** insert behind `pg_advisory_xact_lock(994001)` and reads the previous
   row each time (`ALP:60-105`).
5. Merchant wallets have `shard_count = 1`: every posting to a busy wallet serialises on one row.
6. `journal_lines` checkpoint lookups by `(gl_account_id, shard_id, shard_seq)` lack a `created_at` bound, so
   partition pruning is weak (`CheckpointService.ts:96-99`); 2023–2028 partitions pre-created mostly empty.
7. PgBouncer pools (4 aliases × 2 users × 50) can exceed `max_connections=300` (`P18:230,533`).
8. Read models exist but most dashboards still query base tables; keyset pagination only on merchant `/payments`
   (GAP-002/006).

### 2.3 Integrity and operations

1. 298 of 375 timestamp columns are `timestamp(3)` without time zone; correctness depends on session timezone
   (`utcSession.ts:18`, PgBouncer forwarding unverified).
2. No DB balance enforcement for journal entries; idempotent replay does not compare payloads.
3. Missing FKs: `payment_attempts.wallet_id`, `wallet_gl_account_id`, `reconciliation_items.gateway_id`,
   `operator_case_id`, `gl_shard_repairs.actor_id`, `approval_request_id`; `shard_seq > 0` NOT VALID never validated
   (`M/20261107090000:71`); free-text status columns without CHECKs.
4. Replication asynchronous (`synchronous_standby_names` unset), no failover manager, `max_slot_wal_keep_size` unset
   (dead replica can fill the primary disk), no `idle_in_transaction_session_timeout`, no server/role
   `statement_timeout`, no `wal_compression`, no `log_min_duration_statement`.
5. `http_access_logs` has no DEFAULT partition (inserts fail if the cron misses).
6. Unsafe migration pattern recorded (GAP-062: non-`NOT VALID` CHECK, non-concurrent index, no `lock_timeout`).
7. 57 SQL-only objects tracked by name only (GAP-076); no schema-version check at API boot.
8. 89 `@updatedAt` columns rely on Prisma; some have no DB default.

---

## 3. S-DB items (compatible, during coexistence)

Each item: change, TS impact, migration notes, verification.

| ID | Change | TS impact | Notes / verification |
| :--- | :--- | :--- | :--- |
| S-DB-01 | **Schema version boot gate**: core (TS and Rust) refuses to start unless `schema_versions.version` ∈ `[REQUIRED_MIN, REQUIRED_MAX]` declared by the release (N-1 compatibility) | TS patch: call a new `assertSchemaCompatible()` in `start()` before step 1 | Test: start against an older DB → exit 1 with `SCHEMA_VERSION_INCOMPATIBLE have=X need=[A,B]` |
| S-DB-02 | **Close the audit delete bypass**: new role `pgw_retention` (NOLOGIN); `SECURITY DEFINER` function `pgw_retention_purge(p_table regclass, p_before timestamptz, p_limit int)` owned by `pgw_retention`, allowlisted tables only, writes a summary row to `retention_runs`; trigger now allows DELETE only when `current_user = 'pgw_retention'` (inside the definer function); `REVOKE DELETE ON audit_log FROM pgw_app` | TS `RetentionWorker` calls the function instead of `DELETE` (small patch) | Test: `SET pgw.audit_retention='on'; DELETE FROM audit_log …` as `pgw_app_login` → permission denied |
| S-DB-03 | **Least-privilege runtime roles**: `PG_APP_PASSWORD` mandatory (pgctl refuses deploys where the app would run as owner); owner removed from PgBouncer userlist except the migration alias; new `pgw_report_ro` (SELECT on an allowlisted set of tables/columns via a `reporting` schema of views excluding secret columns), `REPORT_READONLY_DATABASE_URL` always set | none (config) | Verify `SELECT current_user` from each service; report executor cannot read `credential_sets` |
| S-DB-04 | `http_access_logs` and `attempt_step_logs` (log DB) get DEFAULT partitions + an alert when rows land there; partition maintenance runs inside core's JournalPartitionWorker as well as cron | none | Kill cron for a month in staging → inserts succeed, alert fires |
| S-DB-05 | **Server settings**: `max_slot_wal_keep_size = 64GB` (sized to disk), `idle_in_transaction_session_timeout = 60s` (role-level for app roles), role-level `statement_timeout = 30s` for app roles (report role 15 s, worker role 120 s), `wal_compression = lz4`, `log_min_duration_statement = 500ms`, `log_lock_waits = on`, `hot_standby_feedback = on` on reporting replicas, `track_activity_query_size = 4096` | none (TS already sets `SET LOCAL statement_timeout` where it needs longer) | Verify long-running TS jobs (reconciliation, report execution) are under the role limits or set `SET LOCAL` |
| S-DB-06 | **Retention indexes** `CREATE INDEX CONCURRENTLY` BRIN on `notifications(created_at)`, `inbound_events(received_at)`, core `attempt_step_logs(created_at)`, `background_jobs(finished_at)` | none | `EXPLAIN` of retention queries uses the BRIN |
| S-DB-07 | **Integrity constraints**: add FKs listed in §2.3 and CHECKs (`amount >= 0`, `total_amount = requested_amount + surcharge` where columns exist, `currency ~ '^[A-Z]{3}$'`, status CHECKs on free-text status columns) as `NOT VALID`; validate after a data audit script proves no violations; validate `shard_seq > 0` with the pre-genesis carve-out | none if data is clean; violations are bugs to fix first | Audit queries committed under `db/audits/`; `VALIDATE CONSTRAINT` in a separate migration |
| S-DB-08 | **Index slimming on `payment_attempts`** (and `background_jobs (state, available_at)`): drop indexes with `idx_scan = 0` over a 14-day production window **and** no TS/Rust query plan using them (checked by running the route parity suite with `auto_explain`); set `fillfactor = 80`; `CREATE INDEX CONCURRENTLY` partial indexes for velocity: `(client_ip, created_at) WHERE …` | none | Before/after: insert/update latency and WAL bytes per attempt in BENCHMARKS |
| S-DB-09 | **`updated_at` in the database**: for the 89 `@updatedAt` columns add `DEFAULT now()` and a shared `BEFORE UPDATE` trigger `pgw_touch_updated_at()` | Prisma still sets the value; trigger overrides with `now()` — equal up to milliseconds; parity normaliser masks timestamps | Removes a whole class of Rust bugs (forgotten `updated_at`) |
| S-DB-10 | **Online-safe migration convention** (§8) + a linter (`core-rs migrate lint`, initially a Bun script) that rejects `CREATE INDEX` without `CONCURRENTLY` on existing tables, constraints without `NOT VALID`, missing `SET lock_timeout`, `ALTER COLUMN TYPE` on large tables, `ADD COLUMN … DEFAULT volatile` | all new migrations | GAP-062 procedure documented |
| S-DB-11 | **PgBouncer sizing**: `default_pool_size` per alias computed so Σ pools ≤ `max_connections − reserved(20)`; separate pools per role; `server_lifetime 3600`, `server_idle_timeout 600`; `max_prepared_statements` kept ≥ 256 | none | pgctl computes and validates |
| S-DB-12 | **Replication safety**: `synchronous_standby_names = 'ANY 1 (<replica app names>)'` when ≥ 1 replica and `PG_SYNC_COMMIT = on` (default on for ledger clusters); `pg_hba` replication entries only for replica and backup IPs; replication slot monitoring | write latency +1 RTT to the nearest standby | Measure in BL-1/BL-3 before enabling in production |
| S-DB-13 | **Fingerprint SQL-only objects** (GAP-076): `core-rs schema check-sql-objects` stores `md5(pg_get_functiondef / pg_get_indexdef / pg_get_triggerdef)` in the allowlist and fails on drift | CI only | |
| S-DB-14 | **Audit chain head** (audit DB): table `audit_chain_head(id=1, seq_no, row_hash)`; trigger reads/updates it `FOR UPDATE` instead of scanning `audit_records` for the last row; hash formula unchanged; shipper inserts in batches of up to 500 rows per transaction (the lock is taken once per transaction) | TS shipper unchanged (works row by row); Rust shipper batches | Verify `verify_audit_chain()` true; ingestion rate in BENCHMARKS |
| S-DB-15 | **Session timezone hardening**: pool `after_connect` `SET TIME ZONE 'UTC'` (Rust); TS `prisma/client/base.ts` pinned (GAP-030 residual) | TS patch | Test via PgBouncer |

---

## 4. E-DB items (after the TS backend is retired)

### E-DB-01 Convert every `timestamp(3)` to `timestamptz(3)`

- Scope: ~298 columns (list generated by `core-rs schema list-naive-timestamps`).
- Method per table size (measure with `pg_total_relation_size`):
  - **< 2 GB**: in a maintenance window, `ALTER TABLE … ALTER COLUMN c TYPE timestamptz(3) USING c AT TIME ZONE
    'UTC'` (one rewrite per table; combine all columns of a table in one `ALTER`).
  - **≥ 2 GB, not partitioned** (e.g. `payment_attempts`): expand/contract — add `c_tz timestamptz(3)`; trigger keeps
    `c_tz = c AT TIME ZONE 'UTC'` on write; batch backfill (10k rows per batch, `pg_sleep` throttle, progress table);
    Rust reads `c_tz` when backfill completes (feature flag); swap names in a short transaction (`ALTER TABLE … RENAME`)
    with `lock_timeout = 2s` and retries; drop old column later; rebuild indexes on the new column `CONCURRENTLY`
    beforehand.
  - **`journal_lines`** (partitioned on `created_at`): the partition key type must match across partitions. Create
    `journal_lines_v2` partitioned on `created_at timestamptz`; from a cutover month, new partitions attach to v2
    only; Rust writes to v2 for `created_at >= cutover`; reads use a `UNION ALL` view `journal_lines_all` during
    transition; historical partitions are converted one by one off-peak (`CREATE TABLE … AS`, verify counts/sums,
    `ATTACH PARTITION` to v2, drop old); checkpoint/repair code reads through the view until conversion completes.
- Rust side: `chrono::DateTime<Utc>` everywhere; generated types switch automatically from introspection.

### E-DB-02 Split hot attempt state from bulky attempt detail

- New 1:1 table `payment_attempt_details(attempt_id PK/FK, customer_fields_enc, context_ciphertext, user_agent,
  client_ip_enc, raw_customer_fields_enc, …)`; `payment_attempts` keeps state-machine columns, amounts, references,
  routing and timestamps only. Benefits: smaller hot rows, more HOT updates (status changes no longer rewrite large
  JSON), lower WAL.
- Migration: expand/contract (dual-write, backfill, switch reads, drop columns).

### E-DB-03 PII protection with blind indexes

- Keys: vault v2 key ids `pii-enc` (encryption) and `pii-blind-index` (HMAC); separate from other keys.
- Columns: for each searchable identifier keep `<field>_bidx bytea(32) = HMAC-SHA256(blindKey, normalise(value))` and
  `<field>_enc text` (vault v2). Normalisation: phones → E.164 (Libyan rules from `lib/zReady`), emails → lower-case
  trimmed, card alias → as issued, IP → canonical text form.
- Tables: `payment_attempts`/`payment_attempt_details` (phone, card_alias, device_fingerprint, client_ip),
  `merchants` (contact/support email and phone, tax_id, registration_no), `users` (email, phone),
  `beneficial_owners` (names, date of birth — encrypted, names searchable only by exact normalised match),
  `merchants.payout_bank_details_json`, `cashout_requests.destination_bank_json` (encrypted whole).
- Velocity and screening queries switch to `= <bidx>` with B-tree indexes.
- **Behaviour change**: admin search over PII becomes exact-match (no substring/trigram on PII). Requires product
  sign-off; record in the E-item.
- Migration: add columns, backfill in batches through a Rust job (decrypt nothing; values are plaintext today), switch
  reads, drop plaintext columns and trigram indexes on PII.

### E-DB-04 Row Level Security for tenant data

- Tables: every table with `merchant_id` that merchant-channel code reads (payment_attempts, payment_links,
  applications, wallets, access_tokens, webhook endpoints/deliveries, notifications (merchant recipients),
  cashout_requests, disputes, adjustments (merchant view), rm_* read models, report spec records, storage objects with
  tenant scope).
- Policies: `USING (merchant_id = current_setting('app.tenant_id', true)::uuid)` and the same `WITH CHECK`.
- Roles: `pgw_merchant_rt` (subject to RLS) used for merchant-channel and external API requests; `pgw_core_rt`
  (staff/admin, `BYPASSRLS` only for staff-scoped code paths) and `pgw_worker_rt` (`BYPASSRLS`). In transaction
  pooling the role switch is `SET LOCAL ROLE pgw_merchant_rt` plus `SELECT set_config('app.tenant_id', $1, true)` at
  the start of each merchant-channel transaction (done by `pg-db::uow` from `RequestCtx`).
- A missing tenant id makes `current_setting` return NULL → zero rows (fail closed).
- Tests: a catalog check that every tenant table has RLS enabled and a policy; an IDOR test matrix per merchant route.
- Performance: policies are simple equality on indexed columns; benchmark BL-5 before/after.

### E-DB-05 Service roles

| Role | Login | Used by | Privileges |
| :--- | :--- | :--- | :--- |
| `pgw_owner` | yes (migrations only, via session alias) | `core-rs migrate` | owns schema |
| `pgw_core_rt` | yes | core HTTP (admin/checkout channels) | DML on app tables, no DDL, no DELETE on append-only tables |
| `pgw_merchant_rt` | via `SET LOCAL ROLE` | merchant channel | RLS-subject DML on tenant tables |
| `pgw_worker_rt` | yes | background runtime | DML incl. queue maintenance |
| `pgw_report_ro` | yes | report executor | SELECT on `reporting` views |
| `pgw_retention` | no | definer of purge functions | DELETE on allowlisted tables |
| `pgw_ledger_maintenance` | no | archive/repair functions | as today |
| `pgw_replication` | yes | replicas, backup | REPLICATION |
| audit/log writers | yes | audit shipper, log sink | INSERT/SELECT only; databases owned by `pgw_owner` |

### E-DB-06 Partitioned queue tables with drop-based retention

- `outbox_events`, `audit_outbox`, `background_jobs`, `notifications`, `merchant_webhook_deliveries`,
  `inbound_events`: partition by `created_at` (daily for outboxes, monthly for the others), PK `(id, created_at)`,
  DEFAULT partition, per-partition autovacuum (`autovacuum_vacuum_scale_factor = 0.01`, `fillfactor = 80`).
- Claim queries keep ordering by `id` (bigint identity is global across partitions).
- Retention: detach + drop partitions older than retention once every row in them is processed/shipped (worker checks
  `NOT EXISTS (unprocessed)` per partition). Webhook delivery history keeps all attempts (E-F08 adds an attempts table).
- Migration (queue tables can be swapped): create `<table>_v2` partitioned; switch writers to v2 (Rust flag); let
  consumers drain v1; move unprocessed rows; drop v1.

### E-DB-07 Attempt archive and ledger archive

- `payment_attempts_archive` (monthly partitioned by `terminal_at`) receives attempts terminal for longer than
  `ATTEMPT_HOT_RETENTION_DAYS` (default 400) via `pgw_archive_attempts()` (definer); reads for old attempts fall back
  to the archive.
- Ledger archive per `project-design/parts/09-future-and-unimplemented/04-ledger-archive-and-shard-repair.md`: archive
  only below a verified checkpoint, per-shard manifest (`archived_through_seq`, sum, hash), repair from archive + live
  by default, anchor shortcut behind a flag, runs under `pgw.ledger_maintenance`. Add `created_at` bounds to
  checkpoint lookups so pruning works.

### E-DB-08 Ledger integrity in the database

- `CONSTRAINT TRIGGER journal_entry_balanced AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED` checking
  `Σ signed amount = 0` per `entry_id` at commit (one indexed aggregate per entry; benchmark overhead, target < 0.2 ms
  per posting; behind a flag until measured).
- `journal_entries.payload_hash` (SHA-256 of the canonical posting template); on `ON CONFLICT` replay compare hashes
  and return `409 LEDGER_IDEMPOTENCY_PAYLOAD_MISMATCH` on difference (new error code, versioned API note).

### E-DB-09 Adaptive wallet sharding

- Allow the shard scaler to widen merchant wallets for **credits** (credits spread across shards); debits keep the
  wallet advisory lock and compute balance as Σ shards inside the transaction (already how balances work); remove the
  "debits always shard 0" rule only after property tests prove balances and checkpoint proofs stay exact.

### E-DB-10 Identifiers and enums

- New rows use UUIDv7 everywhere (`DEFAULT uuidv7()`, a PostgreSQL 18 built-in, as a safety net behind app-generated
  ids); `SandboxSyncAudit` cuid PK migrated to uuid.
- Free-text status columns (`payment_attempts.mode`, `sub_mode`, `substatus`, `canonical_error`, …) get CHECKs or
  native enums; new `currencies(code, minor_unit, active)` table referenced by currency columns (FK `NOT VALID` →
  validate).

### E-DB-11 Single source of truth for logs and audit

- Make the audit DB authoritative for audit reads (admin audit views read through a Rust audit-read API with keyset
  pagination); stop writing core `audit_log` after a dual-read verification period; same for core
  `attempt_step_logs` (log DB is authoritative). Retention of `audit_records` by monthly partitions with a signed
  anchor per closed partition.

### E-DB-12 PostgreSQL 18 features to adopt

| Feature | Use |
| :--- | :--- |
| `uuidv7()` | column defaults (E-DB-10) |
| `RETURNING OLD.*, NEW.*` | CAS status updates return the previous status in one statement (flow engine) |
| Temporal constraints `PRIMARY KEY/UNIQUE … WITHOUT OVERLAPS` on range columns | commission profiles, velocity rules, settings `effective` periods: prevent overlapping validity windows in the DB |
| Virtual generated columns | derived totals (`total_amount`) without storage |
| Asynchronous I/O (`io_method = io_uring` where the kernel supports it, else `worker`) | sequential scans, vacuum, checkpoint I/O |
| B-tree skip scan | lets E-DB drop some multi-column indexes whose leading column is low-cardinality |
| Data checksums on by default in `initdb` | keep enabled; pgctl verifies |

### E-DB-13 Read models and pagination

- Dashboards read `rm_*` tables; add `rm_ledger_daily_balances` maintained from `ledger.entry_posted` (currently a
  no-op topic); keyset pagination for every list endpoint (versioned query parameter `cursor`; offset kept for
  compatibility); per-endpoint replica routing table in configuration (E-F01).

### E-DB-14 High availability

- Optional `ha` topology in pgctl: Patroni (3-node etcd or the Patroni Raft mode) managing the primary and standbys,
  synchronous replication `ANY 1`, PgBouncer pointing at a Patroni-managed VIP or HAProxy with Patroni health checks;
  `pgctl db failover|switchover`. Default topologies keep a single primary + sync standby with manual
  `pgctl db promote`. Chapter 7 §9.

---

## 5. Migration ownership and tooling after Prisma (P10-T01)

- Directory `db/migrations/NNNNNNNNNNNNNN_name/migration.sql` (history copied verbatim from
  `core-back/prisma/migrations`, same directory names so `_prisma_migrations.migration_name` matches).
- `core-rs migrate deploy`:
  1. connect with the owner URL through the session alias; `SET lock_timeout = '5s'`; take
     `pg_advisory_lock(72707369)` (Prisma Migrate's key, so a concurrent Prisma run is excluded);
  2. read `_prisma_migrations` (applied names, checksums = SHA-256 of file content, `finished_at`, `rolled_back_at`);
  3. refuse if an applied migration's checksum differs (same rule as Prisma) or a failed migration is unresolved;
  4. apply pending migrations each in its own transaction unless the file starts with `-- pgw:no-transaction` (needed
     for `CREATE INDEX CONCURRENTLY`); insert `_prisma_migrations` rows with the same columns Prisma writes;
  5. append `schema_versions` (same SQL as `prisma/migrateDev`).
- `core-rs migrate status --json` (used by pgctl planning), `new <name>` (scaffold + linter), `rehearse` (apply to a
  disposable PostgreSQL 18 restored from the latest backup or seeded), `lint`.
- Sandbox DB migrated with the same command and `--database sandbox`.
- `db/schema-snapshot.sql` regenerated after each migration (`pg_dump --schema-only`, normalised) and committed; codegen
  and Report Studio catalog read from the migrated DB.

---

## 6. Online migration recipes (use these, never improvise)

| Change | Recipe |
| :--- | :--- |
| Add nullable column | `ALTER TABLE … ADD COLUMN c type;` (instant) |
| Add NOT NULL column with default | PostgreSQL 11+ stores constant defaults without rewrite: `ADD COLUMN c type NOT NULL DEFAULT 'const'`; for volatile defaults add nullable → backfill → `SET NOT NULL` via `CHECK (c IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` |
| Add index | `CREATE INDEX CONCURRENTLY` in a `-- pgw:no-transaction` migration; on failure drop the INVALID index and retry |
| Add FK / CHECK | `ADD CONSTRAINT … NOT VALID;` then separate migration `VALIDATE CONSTRAINT` |
| Change column type (large table) | add new column → trigger dual-write → batched backfill → switch reads → rename → drop |
| Rename column used by running code | add new column + dual-write view/trigger for one release; never rename in place while N-1 code reads it |
| Drop column | release N stops reading/writing it; release N+1 drops it |
| Partition existing large table | create partitioned twin; switch writes; backfill historical partitions; `UNION ALL` view during transition; drop original |
| Every migration | starts with `SET lock_timeout = '5s'; SET statement_timeout = '15min';` and is idempotent where possible (`IF NOT EXISTS`) |

---

## 7. Verification for every database change

1. Linter passes. 2. `core-rs migrate rehearse` on a production-sized restore (from the latest backup) records
duration and lock waits in the PR. 3. Parity suites green on the migrated schema (S items) or full regression (E
items). 4. Ledger invariants, checkpoint proofs and `verify_audit_chain()` green after migration. 5. Rollback plan
written (for expand steps: drop the new structure; contract steps are not reversible and need explicit sign-off).

## 8. Compatibility rules

### 8.1 N-1

Release N must run against schema version N−1 and N; schema N must support release N−1. Each release declares
`[REQUIRED_MIN, REQUIRED_MAX]` (S-DB-01); pgctl refuses to deploy an app release outside the range of the database
it targets and orders "migrate then deploy" or "deploy then migrate" accordingly.

### 8.2 Coexistence (Track P/S)

While TS and Rust both run, no migration may break TS: S-DB items only, each tested by running the TS core test
suite and the parity suite against the migrated schema.
