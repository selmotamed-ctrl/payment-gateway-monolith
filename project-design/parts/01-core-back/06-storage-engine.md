---
id: core.storage
title: Storage Engine
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: 5a24f6f+working-tree
code:
  - core-back/lib/storageEngine/telemetry.ts
  - core-back/lib/realtimeBus.ts
  - core-back/lib/storageEngine/**
  - core-back/engine/workers/productionRuntime.ts
  - core-back/api/internal/backups.ts
  - core-back/prisma/migrations/**
tests:
  - core-back/test/storage-engine/telemetry-and-realtime.test.ts
  - core-back/test/storage-engine/**
  - core-back/test/storage-engine/performance/**
  - core-back/test/backup-admin/**
gaps:
  - Only the admin merchant list and global search expose `x-pg-served-by`; other list/export routes still read the primary directly.
  - Read models are written by `attempt.transitioned` only and are not read by dashboards.
  - `ledger.entry_posted` and four other outbox topics have no-op handlers.
  - `outbox_events` and `audit_outbox` rows are never deleted; `audit_outbox` only gets `shipped_at`.
  - Keyset pagination is not implemented; `listQuery` uses offset pagination.
  - There is no `gateway_wire_logs` table and no on-disk log spool.
  - Access logging records `dbQueries` and `dbDurationMs` as zero.
  - Storage health is exposed only through the adapter API, not through `/health`.
  - Replica reads cover global search, the admin merchant list and three merchant list endpoints; other lists/exports still read the primary.
  - "Residual (GAP-030): `core-back/prisma/client/base.ts` still builds its Prisma client without the UTC startup option, so a database whose own default timezone is not UTC reaches that client unpinned; the provisioners set the cluster default to UTC."
  - "The leader election holds one extra dedicated PostgreSQL connection per core node and cannot run through PgBouncer transaction pooling (GAP-012)."
---

# Storage Engine

## 1. Purpose and scope

The storage engine is the boundary between domain code and PostgreSQL 18, Redis, the dedicated audit database and the dedicated log database. It owns:

- the `StorageEngine` composition object and its ports;
- the transactional unit of work that couples domain writes, `outbox_events` and `audit_outbox`;
- the post-commit WAL flush watermark used by LSN-aware reads;
- primary/replica read routing and replica health tracking;
- Redis cache and sliding-window velocity counters, with an in-memory fallback;
- the dedicated audit hash-chain append adapter and audit query adapter;
- the buffered operational step/access log sink;
- GL account shard arithmetic and shard-aware ledger writes;
- the transactional outbox relay and audit shipper workers;
- the read-model projection for `rm_merchant_daily_stats` and `rm_route_daily_volumes`;
- the mTLS backup-control client used by `core-back` to reach `pg-backup-daemon`;
- the storage health snapshot API.

It does not own the Prisma schema or migration workflow (`core.storage` is paired with `core.data`), the backup daemon implementation (`07-deploy`), the global-search provider catalogue (`core.search`), or domain ledger/attempt decisions.

Dependent systems: `engine/**` through the platform runtime, `api/internal/{admin,merchant,checkout,backups}.ts`, the worker runtime, the global search route, and the storage-engine and backup-admin test suites.

## 2. Design intent (extracted and synthesized from ./design)

The historical storage blueprint defines a thin, ACID write path for a high-volume switch:

- A payment or ledger write touches the operational row, one `gl_account_shards` balance row, one `outbox_events` row and one `audit_outbox` row in a single transaction.
- The unit of work reports a commit WAL position so a caller can ask for a replica that has replayed at least that position.
- System GL accounts are split into 16 deterministic shards; merchant wallets use a single shard. Shard rows are locked in stable sorted order to avoid deadlocks.
- Outbox events project read models asynchronously so dashboards do not aggregate the ledger on the write path.
- Replica reads are selected by lag and LSN, with primary fallback.
- Redis provides L2 cache and Lua-backed velocity windows; it is never authoritative for money.
- Audit is shipped asynchronously to a dedicated append-only database with a SHA-256 hash chain and immutable rows.
- Operational step/access logs go to a separate log database so logging cannot block a payment.
- Backups are controlled through an mTLS daemon that wraps WAL-G or Barman.

The blueprint's implementation claims must not be repeated as current behavior. The actual code differs in these material ways:

- `ledger.entry_posted` is registered but its handler is a no-op; only `attempt.transitioned` projects read models.
- The two read models are written but not read by dashboards or list endpoints.
- `AuditShipperWorker` marks `audit_outbox.shipped_at`; it never deletes shipped rows.
- Replica routing is used by global search and three merchant list endpoints, not by all dashboards, lists and exports.
- Pagination is offset-based, not keyset-based.
- Access logs record zero database query metrics.
- There is no `gateway_wire_logs` table and no disk spool for the log sink.

## 3. As-built architecture

### 3.1 Composition root

`core-back/lib/storageEngine/index.ts` builds one `StorageEngine`:

- `createStorageEngine` resolves `DATABASE_URL`, `DATABASE_REPLICA_URLS`, `AUDIT_DATABASE_URL`, `LOG_DATABASE_URL` and Redis from the environment (`index.ts:56-71`).
- It creates the primary Prisma client and one Prisma client per replica URL (`index.ts:72-80`).
- It constructs `PostgresReplicaReadStore` and starts the LSN monitor (`index.ts:82-87`).
- It constructs `PostgresUnitOfWorkAdapter` with an optional post-commit callback (`index.ts:89-92`).
- It selects `RedisCacheAdapter` when a Redis URL exists, otherwise `MemoryCacheAdapter` (`index.ts:94-98`).
- It creates `DedicatedAuditDatabaseDriver` from a dedicated `pg.Pool` and `DedicatedPostgresLogSink` from a separate `pg.Pool` (`index.ts:100-114`).
- It exposes `uow`, `readStore`, `cache`, `auditStore`, `logSink`, `primary`, `health()` and `shutdown()` (`index.ts:116-209`).
- It exports `readThroughReplica` and `readThroughReplicaOrPrimary` helpers (`index.ts:227-268`) and a process-wide singleton (`index.ts:214-225`).

`core-back/index.ts` gets the singleton, installs it into the platform runtime, and installs the log sink into the request logger before listening (`index.ts:255-260`). Shutdown stops the LSN monitor, closes the log sink and cache, disconnects clients and ends both pools (`index.ts:198-207`, `core-back/index.ts:285-291`).

### 3.2 Ports and adapters

`core-back/lib/storageEngine/ports.ts` defines the contracts:

- `UnitOfWorkPort.run(fn, options)` returns `{ data, commitLsn, durationMs }`.
- `StorageTx` exposes `db`, `outbox`, `audit` and `lockGlAccountShardsSorted`.
- `ReadStorePort.execute(consistency, fn, options)` returns `{ data, servedBy, replicaLagMs? }`.
- `CachePort` exposes `get`, `getOrLoad`, `set`, `del`, `incrWindowCounter`, optional `publishInvalidation` and `close`.
- `AuditStorePort` exposes audit query, count, hash-chain verification and detail lookup.
- `LogSinkPort` exposes step/access log writes, attempt step-log queries, `flush` and `close`.
- `StorageEngine` aggregates the ports plus primary client, `health()` and `shutdown()`.

The concrete adapters are `PostgresUnitOfWorkAdapter`, `PostgresReplicaReadStore`, `MemoryCacheAdapter`, `RedisCacheAdapter`, `DedicatedAuditDatabaseDriver`, `DedicatedPostgresLogSink` and `BackupControlClient`.

### 3.3 Unit of work, outbox and audit outbox

`PostgresUnitOfWorkAdapter.run` opens a Prisma interaction transaction (`uowAdapter.ts:25-152`):

1. It sets a local statement timeout at least one second long and 250 ms below the transaction timeout (`uowAdapter.ts:26-30`).
2. It buffers outbox and audit envelopes in memory during the callback.
3. It deduplicates and sorts requested GL shard targets by account id and shard id, then selects them with `FOR UPDATE` in that order (`uowAdapter.ts:52-97`).
4. It runs the caller callback.
5. It inserts all buffered outbox events with `createMany` and all buffered audit rows with `createMany` inside the same transaction (`uowAdapter.ts:102-137`).
6. It reads `pg_current_wal_lsn()` inside the transaction (`uowAdapter.ts:139-142`).
7. After commit it calls the optional `onAfterCommit` wake-up, swallowing wake-up failures (`uowAdapter.ts:154-159`).
8. It reads `pg_current_wal_flush_lsn()` on the primary and replaces the in-transaction LSN when available (`uowAdapter.ts:161-172`). This is the post-commit flush LSN that makes an `atLeastLsn` replica read safe.

The audit id is generated by `uuidv7()` inside `StorageTx.audit.record` and preserved by the shipper for idempotent append (`ports.ts:24-51`, `uowAdapter.ts:46-50`).

### 3.4 Outbox relay and audit shipper

`OutboxRelayWorker` (`outboxWorkers.ts:134-248`) claims up to `batchSize` unprocessed rows with `FOR UPDATE SKIP LOCKED`, runs a handler, then updates `processed_at`. Registered handlers (`outboxWorkers.ts:149-157`):

| Topic | Handler |
| :--- | :--- |
| `attempt.transitioned` | `projectAttemptTransition` updates both read models |
| `ledger.entry_posted` | no-op |
| `merchant.updated` | no-op |
| `kyb.document_uploaded` | no-op |
| `reconciliation.completed` | no-op |
| `config.invalidated` | no-op |

`projectAttemptTransition` validates the payload shape defensively and uses `INSERT ... ON CONFLICT DO UPDATE` for `rm_merchant_daily_stats` and `rm_route_daily_volumes` (`outboxWorkers.ts:68-132`). It treats rows without an `event` marker as `created`, preserving the historical "every attempt counted at creation" behavior (`outboxWorkers.ts:82-90`).

`AuditShipperWorker` (`outboxWorkers.ts:268-385`) claims unshipped rows, appends them through `DedicatedAuditDatabaseDriver.appendBatch`, and then updates `shipped_at = now()` by id. The append is idempotent on the source id, so a crash between append and mark re-appends safely. There is no delete.

### 3.5 Replica read router

`PostgresReplicaReadStore` keeps one handle per replica with `healthy`, `lastReplayLsn`, `lagMs` and `consecutiveFailures` (`readStoreAdapter.ts:6-13`). A 150 ms interval monitor reads `pg_last_wal_replay_lsn()` and `now() - pg_last_xact_replay_timestamp()` (`readStoreAdapter.ts:31-76`). A replica becomes unhealthy after two consecutive monitor failures.

Selection is round-robin over healthy replicas:

- `"primary"` bypasses replicas.
- `"replica"` accepts a healthy replica whose `lagMs` is at or below `READ_REPLICA_MAX_LAG_MS`.
- `{ atLeastLsn, maxWaitMs }` accepts a replica whose replay LSN is at least the requested watermark, polling and refreshing watermarks until the deadline (`readStoreAdapter.ts:78-120`).
- If no replica qualifies, or the chosen replica throws, the query runs on the primary (`readStoreAdapter.ts:165-192`). A query failure marks the replica unhealthy.

Current replica call sites are:

- global search: `core-back/api/internal/admin.ts:687`;
- merchant wallet list: `core-back/api/internal/merchant.ts:1323`;
- merchant link list: `core-back/api/internal/merchant.ts:1661`;
- merchant payment list: `core-back/api/internal/merchant.ts:1744`.

No dashboard aggregate, export or other list uses the router.

### 3.6 Redis cache and velocity

`MemoryCacheAdapter` is a process-local map with TTLs, single-flight `getOrLoad`, prefix deletion and sliding windows (`redisCacheAndVelocityAdapter.ts:42-141`). It is the fallback when Redis is unavailable or not configured.

`RedisCacheAdapter` adds a local L1 cache, a JSON L2 cache with `EX` TTL, prefix deletion and a preloaded Lua velocity script (`redisCacheAndVelocityAdapter.ts:168-345`). The script:

- removes entries older than the window;
- adds the current amount/sequence member;
- sums amounts from member prefixes;
- returns count, amount, count-violation and amount-violation flags;
- refreshes the key TTL.

On a Redis error or timeout, `incrWindowCounter` follows the velocity failure policy (`REDIS_VELOCITY_FAILURE_POLICY`, default `local-fallback`, which counts in this node's memory; see section 12). `del` uses Redis `KEYS` followed by `DEL` (`redisCacheAndVelocityAdapter.ts`), which is a blocking scan on a large keyspace and is not production-safe at scale. `getOrLoad` exists but is not used by the core read paths; the main cache consumer is the attempt guard velocity store (`core-back/engine/guards/AttemptGuardPipeline.ts`). Redis invalidation is published through a separate invalidation bus, not `CachePort.publishInvalidation`.

### 3.7 Audit database adapter

`DedicatedAuditDatabaseDriver` (`auditAndLogAdapters.ts:99-331`) appends with `pg` directly:

- It opens a transaction and takes `pg_advisory_xact_lock(hashtext(tableName:hash-chain))` to serialize chain appends.
- It skips ids already present, inserts the audit fields without `prev_hash`/`row_hash`, and reads the values computed by the audit database BEFORE INSERT trigger (`pg_advisory_xact_lock(994001)` serializes all core nodes).
- It queries with SQL filters, cursor and offset support, caps `limit` at 5,000 and orders by `created_at DESC, id DESC`.
- It exposes `verifyHashChainIntegrity(limit?)`, recomputing each row and returning the first broken id.

The audit table itself is provisioned by `deploy/provisioners/auditAndLogDbProvisioner.ts` with an append-only trigger that rejects `UPDATE`, `DELETE` and `TRUNCATE`, plus least-privilege grants.

### 3.8 Operational log sink

`DedicatedPostgresLogSink` (`auditAndLogAdapters.ts:333-524`) buffers step and access rows in memory:

- The step buffer is bounded by `STORAGE_LOG_BUFFER_MAX`; when full it drops the oldest row (`auditAndLogAdapters.ts:368-371`).
- It keeps the last 500 step logs per attempt for in-memory fallback and caps remembered attempts at 1,000 when no log DB is configured (`auditAndLogAdapters.ts:372-383`).
- It flushes every `STORAGE_LOG_FLUSH_INTERVAL_MS`, when the step buffer reaches 250 rows, or on `close`.
- Flush batches up to 500 rows per table and uses multi-row inserts; step logs use `ON CONFLICT (id, created_at) DO NOTHING`.
- On a database error the step batch is put back if it still fits; the access batch is not explicitly requeued, so a failed flush can lose access-log rows.
- With no log DB, step logs are remembered in memory and access logs are dropped.

There is no disk spool. There is no `gateway_wire_logs` table. The request logger always supplies `dbQueries: 0` and `dbDurationMs: 0` (`core-back/lib/requestLogger/index.ts:185-203`).

### 3.9 Sharding and ledger writes

`shardBalances.ts` defines 16 default shards, excludes `MERCHANT_WALLET`, uses FNV-1a over the attempt/reference id and computes `shardId = hash % count`; unsharded accounts use shard 0 (`shardBalances.ts:1-32`). `ledgerShardWriter.ts` upserts `gl_account_shards` with a signed delta (`credit` negative, `debit` positive) and can pre-create all shards for an account (`ledgerShardWriter.ts:8-51`). `createLedgerPoster` wires the shard writer and an optional `ledger.entry_posted` outbox writer (`ledgerPosterFactory.ts:17-40`). The hardening migration adds a `0 <= shard_id < 16` check.

### 3.10 Read models

The CQRS migration creates `rm_merchant_daily_stats` and `rm_route_daily_volumes` with composite primary keys and a day index. Only `projectAttemptTransition` writes them. There is no `rm_merchant_dashboard_stats` and no `rm_wallet_statements` table. The read models are write-only in current application code.

### 3.11 Backup control client

`BackupControlClient` (`backupControlClient.ts:145-308`) is an HTTP client for the daemon:

- base URL from `BACKUP_DAEMON_URL`;
- keep-alive agents, TLS 1.3 minimum for HTTPS, optional CA/client cert/key from the environment;
- explicit JSON serialization, timeout handling, 502/504 error mapping and a typed `BackupDaemonNotConfiguredError`.

It exposes `overview`, `health`, `triggerBackup`, `runDrill`, `updatePolicy`, `listRuns` and `listDrills`. The internal backup router uses it for overview, trigger, drill and policy. There are no automatic retries or circuit-breaker semantics.

### 3.12 Health

`StorageEngine.health()` probes the primary with `SELECT 1`, each replica, cache set/get, audit pool and log pool with short timeouts (`index.ts:123-197`). It returns `StorageHealth` with primary latency, replica lag/watermarks, cache driver and audit/log configured flags.

The public `GET /health` in `core-back/index.ts:76-115` does not call `StorageEngine.health()`. It reports only background-job queue health. The storage snapshot is currently consumed by tests (`core-back/test/storage-engine/engine-factory.test.ts`) rather than by an operational endpoint.

## 4. Contracts and invariants

- Domain writes that use the UoW and both outbox writers commit the business row, `outbox_events` and `audit_outbox` atomically. A failure rolls back all three.
- The reported `commitLsn` is the post-commit `pg_current_wal_flush_lsn()` when readable; callers can treat an `atLeastLsn` replica as having replayed the commit.
- GL shard locks are taken in `(gl_account_id, shard_id)` order. Callers must pass all targets before making balance-dependent decisions.
- Audit ids are UUIDv7 generated in the UoW; the audit chain is append-only and idempotent by id.
- The audit hash chain canonicalizes JSONB with PostgreSQL `before_json::text`/`after_json::text`; verification reads the same text form. Any change to the trigger field list or canonicalization invalidates historical verification.
- Outbox handlers must be idempotent: a claimed batch is retried after a crash because `processed_at` is updated only after the handler completes.
- The outbox relay processes rows in ascending id order and never deletes them.
- Read consistency is one of `primary`, `replica` or `{ atLeastLsn, maxWaitMs? }`. A replica query failure falls back to the primary; callers must not assume a replica served the read.
- Cache contents are not authoritative. A Redis failure must not fail a payment under the default policy; velocity follows `REDIS_VELOCITY_FAILURE_POLICY` (`local-fallback` default, `fail-open`, `fail-closed`).
- The in-memory velocity fallback (`local-fallback`) is per process and does not coordinate across core nodes: a cluster of N nodes tolerates up to N times the limit during an outage.
- The log sink is best-effort. It may drop the oldest step log when its buffer is full, may drop access logs on a failed flush and does not spool to disk.
- `gl_account_shards.shard_id` is limited to `0..15`; the default shard count is 16 and `MERCHANT_WALLET` is always one shard.
- Backup daemon calls are mTLS when the base URL is HTTPS; a missing client certificate is not silently replaced by an insecure channel.
- `StorageEngine.shutdown()` must be called on process shutdown so monitors, buffers and pools are released.

## 5. Data / API / config / deployment surface

### Schema models

`GlAccountShard`, `OutboxEvent`, `AuditOutbox`, `BackupCatalogRun`, `BackupRestoreDrill`, `RmMerchantDailyStat` and `RmRouteDailyVolume` are the storage-engine-native models. The journal, attempt and audit-log tables are defined by the broader schema (see `core.data`).

### Internal APIs

- `GET /internal/admin/system/backups/overview`
- `POST /internal/admin/system/backups/trigger`
- `POST /internal/admin/system/backups/drill`
- `PUT /internal/admin/system/backups/policy`
- `GET /internal/admin/system/backups/catalog`
- `POST /internal/admin/search` (delegates to the read store, see `core.search`)

### Environment

| Key | Purpose | Default |
| :--- | :--- | :--- |
| `DATABASE_URL` | Primary PostgreSQL 18 URL | required |
| `DATABASE_REPLICA_URLS` | Comma-separated replica URLs | empty |
| `READ_REPLICA_MAX_LAG_MS` | Maximum acceptable replica lag | `2000` |
| `AUDIT_DATABASE_URL` | Dedicated audit DB URL | unset |
| `LOG_DATABASE_URL` | Dedicated log DB URL | unset |
| `REDIS_URL` / `REDIS_NODES` | Redis cache/velocity | unset / empty |
| `REDIS_VELOCITY_FAILURE_POLICY` | Velocity behaviour when Redis is down: `local-fallback`, `fail-open`, `fail-closed` (unknown values fall back to the default) | `local-fallback` |
| `STORAGE_QUERY_TIMEOUT_MS` | Default query timeout budget | `5000` |
| `STORAGE_LOG_BUFFER_MAX` | Log buffer bound | `5000` |
| `STORAGE_LOG_FLUSH_INTERVAL_MS` | Log flush interval | `250` |
| `STORAGE_SHARD_COUNT` | GL shard count, max 16 | `16` |
| `BACKUP_DAEMON_URL` | Daemon base URL | unset |
| `BACKUP_DAEMON_CA_CERT_PATH` | Daemon CA | unset |
| `BACKUP_DAEMON_CLIENT_CERT_PATH` | Daemon client cert | unset |
| `BACKUP_DAEMON_CLIENT_KEY_PATH` | Daemon client key | unset |
| `BACKUP_DAEMON_TIMEOUT_MS` | Daemon request timeout | `15000` |

### Deployment

`deploy/lib/hostPlanner.ts` injects the core environment with the primary/replica/audit/log URLs and backup daemon client paths. Storage hosts receive certificates through `uploadStorageCertificates` in `deploy/deploy.ts`. Storage mTLS consumption by PostgreSQL and Redis is not implemented (see `07-deploy/05-storage-provisioners.md`).

## 6. Operational usage

- Start `core-back` with the primary URL; replica URLs are optional. Replica routing degrades to primary when none is configured.
- Watch `READ_REPLICA_MAX_LAG_MS` when adding lagging replicas; an oversized value makes stale reads more likely.
- Run the outbox relay and audit shipper through `createProductionWorkerRuntime` when `WORKER_ENABLED` is true. Without the audit store the shipper is not registered.
- Send writes through `UnitOfWorkPort`; do not write `outbox_events` or `audit_outbox` directly in new code.
- Use `readThroughReplicaOrPrimary` with the `x-pg-min-lsn` request header for read-after-write consistency. The header is consumed by the search route and the three merchant list routes.
- Inspect the storage snapshot through `getStorageEngine().health()` or the tests; do not assume `/health` includes storage checks.
- Treat Redis as disposable. If Redis is down, velocity evaluation follows `REDIS_VELOCITY_FAILURE_POLICY`: by default process-local memory without cross-node coordination; `fail-open` skips counting; `fail-closed` refuses attempts with `VelocityUnavailableError`.
- Monitor `audit_outbox` growth directly. The shipper marks rows shipped but does not remove them, so a retention job is required outside this code.
- Use `scripts/run-benchmarks.sh` with a real PostgreSQL 18 test database and, optionally, Redis to reproduce write-path numbers.

## 7. Status and deviations

### Implemented

- Ports/adapters and singleton composition (`ports.ts`, `index.ts`).
- Atomic UoW with transactional outbox, transactional audit outbox and sorted GL shard locks.
- Post-commit `pg_current_wal_flush_lsn()` watermark.
- Outbox relay with `FOR UPDATE SKIP LOCKED`, idempotent retry semantics and attempt read-model projection.
- Audit shipper with idempotent append and audit hash-chain verification.
- LSN/lag-aware replica router with primary fallback.
- Redis cache adapter with Lua velocity and memory fallback.
- 16-way shard arithmetic and shard-aware ledger writer.
- Dedicated audit DB and log DB adapters.
- Backup control client with TLS/mTLS support and typed errors.
- Storage health snapshot API.
- Read model tables and writer.
- Test coverage for primitives, UoW, read store, outbox workers, audit chain, log sink, shards, engine factory and performance thresholds.

### Partial

- Read-model adoption: `rm_*` tables are written but no dashboard or list reads them.
- Outbox projection: only `attempt.transitioned` has an effect; `ledger.entry_posted` and four other topics are no-ops.
- Replica routing: only global search and three merchant list endpoints use it.
- Cache: Redis/L1 is used primarily by velocity; `getOrLoad` is available but not used by core read paths.
- Audit/log retention: log partitions have a deploy-side retention function, but core `audit_outbox`, `outbox_events` and the dedicated audit table have no application-level retention job.
- Backup control: the client is implemented and tested, but deployment certificate ownership and daemon-side gaps remain (see `core.backup`).

### Missing / deferred

- Keyset pagination. `core-back/lib/listQuery.ts:220` returns `skip`/`take`; no cursor pagination exists.
- `gateway_wire_logs` table and any raw gateway wire-log persistence. Evidence is stored in redacted step logs only.
- On-disk log spool and durable log backpressure. The buffer drops instead of spooling.
- Storage health endpoint. `StorageEngine.health()` is not wired to HTTP.
- Automatic outbox and audit-outbox pruning/archival.
- Distributed velocity counters when Redis is unavailable.
- A real multi-node cache invalidation path through `CachePort.publishInvalidation` (the method is optional and unused).
- Read models for merchant dashboards or wallet statements. Only the two attempt-derived tables exist.
- A structural benchmark for sustained 1,000+ TPS, deep search or restore throughput (see `core.tests`).

### Known bugs / risks

- `AuditShipperWorker` retains every shipped `audit_outbox` row. At high audit volume this becomes an unbounded primary-database table. Code gap.
- `OutboxRelayWorker` retains every processed `outbox_events` row. The partial index makes the unprocessed scan cheap, but storage still grows. Code gap.
- A failed log flush requeues step logs but not access logs, so access-log rows can be silently lost. Code gap in `auditAndLogAdapters.ts:485-488`.
- `RedisCacheAdapter.del` uses `KEYS`, which blocks Redis on large keyspaces. Code risk.
- The Redis L1 cache returns a 30-second cached value even when the requested L2 TTL is different; invalidation must cover every node. Code risk.
- The replica LSN monitor runs per process and each core node probes every replica every 150 ms. At many nodes this is measurable probe load. Operational risk.
- A replica that throws is marked unhealthy immediately in `execute`, while the monitor requires two failures; the two paths can disagree briefly. Code risk.
- `readThroughReplica` falls back to the primary on any thrown error, including a caller bug, which can hide query errors. Code risk.
- Audit chain appends serialize on a single advisory lock. Throughput is intentionally bounded by the dedicated audit database, but a slow audit DB backpressures the shipper, not the write path. Operational risk.
- `lockGlAccountShardsSorted` returns only rows that already exist; missing shard rows are not created by the lock call. A caller that assumes a complete map can under-lock. Code risk; `ensureAccountShards` must have run.
- `StorageEngine.health()` returns `audit.ok = false` when the audit store is not configured, which conflates "not configured" with "unhealthy". Code risk in monitoring semantics.
- The backup client creates a keep-alive agent once from the environment. Certificate rotation requires a process restart or singleton reset. Operational risk.

## 8. Verification and tests

Relevant test files:

- `core-back/test/storage-engine/primitives.test.ts` — LSN comparison, UUIDv7 and stable JSON.
- `core-back/test/storage-engine/uow.test.ts` — atomicity, outbox/audit rows, shard locks and commit LSN.
- `core-back/test/storage-engine/write-path.integration.test.ts` — live-PostgreSQL write path.
- `core-back/test/storage-engine/outbox-workers.test.ts` — relay, audit shipper and read-model projection.
- `core-back/test/storage-engine/audit-chain.test.ts` — dedicated audit chain and immutability assumptions.
- `core-back/test/storage-engine/log-sink.test.ts` — buffering, flush and attempt lookups.
- `core-back/test/storage-engine/read-store.test.ts` — lag/LSN selection and fallback.
- `core-back/test/storage-engine/ledger-shards.test.ts` — shard arithmetic and balances.
- `core-back/test/storage-engine/cache-velocity.test.ts` — memory and live Redis velocity.
- `core-back/test/storage-engine/engine-factory.test.ts` — factory and health snapshot.
- `core-back/test/storage-engine/performance/storage-performance.test.ts` — pure primitives, UoW, outbox drain, shard reads, audit append, Redis velocity.
- `core-back/test/storage-engine/performance/write-path-benchmark.test.ts` — audit write and shard-read latency.
- `core-back/test/backup-admin/*.test.ts` — backup client and internal routes.

Commands:

```bash
cd core-back && bun test test/storage-engine
cd core-back && bun test test/backup-admin
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test ./scripts/run-benchmarks.sh
```

Suites under `test/storage-engine` and `test/backup-admin` use `databaseIsReachable` and `redisIsReachable` probes. Without PostgreSQL 18 they skip the database `describe` blocks; without Redis they skip the live Redis velocity suite. The pure primitive and memory-cache tests still run. The benchmark runner requires `DATABASE_URL` (or `POSTGRES_TEST_DATABASE_URL` / `STORAGE_TEST_DATABASE_URL`) and exits with code 2 when none is set.

There is no benchmark in this part that proves the blueprint's 1,000+ TPS sustained target, deep-search latency or restore throughput. The performance tests assert generous regression ceilings on a developer machine, not production-scale capacity. No test run was performed for this documentation change.

## 9. Source references

### Old design sections

- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#2-segment-1--the-core-back-storage-driver-engine-core-backlibstorageengine`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#3-2-outbox-driven-read-models--uncompromised-20-group-deep-search-on-replicas`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#5-segment-4--backup-management-orchestrator--admin-control-plane-pg-backup-daemon--core-back--admin-front`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#6-segment-5--horizontal-node-scaling--multi-host-storage-orchestration-in-deploydeployenv--deploydeployts`
- `design/00-process/blueprint-management.md#5-documentation-corrections-backlog`

### Code paths

- `core-back/lib/storageEngine/ports.ts`
- `core-back/lib/storageEngine/index.ts`
- `core-back/lib/storageEngine/uowAdapter.ts`
- `core-back/lib/storageEngine/outbox.ts`
- `core-back/lib/storageEngine/outboxWorkers.ts`
- `core-back/lib/storageEngine/readStoreAdapter.ts`
- `core-back/lib/storageEngine/redisCacheAndVelocityAdapter.ts`
- `core-back/lib/storageEngine/auditAndLogAdapters.ts`
- `core-back/lib/storageEngine/shardBalances.ts`
- `core-back/lib/storageEngine/ledgerShardWriter.ts`
- `core-back/lib/storageEngine/ledgerPosterFactory.ts`
- `core-back/lib/storageEngine/backupControlClient.ts`
- `core-back/lib/storageEngine/lsn.ts`
- `core-back/lib/storageEngine/uuid.ts`
- `core-back/engine/workers/productionRuntime.ts`
- `core-back/lib/requestLogger/index.ts`
- `core-back/lib/listQuery.ts`
- `core-back/api/internal/admin.ts`
- `core-back/api/internal/merchant.ts`
- `core-back/api/internal/backups.ts`
- `core-back/prisma/migrations/20261103000000_postgres18_init/migration.sql`
- `core-back/prisma/migrations/20261103120000_postgres18_storage_engine/migration.sql`
- `core-back/prisma/migrations/20261103130000_cqrs_read_models/migration.sql`
- `core-back/prisma/migrations/20261103180000_storage_hardening/migration.sql`

### Generated appendices

- `project-design/appendices/schema-catalog.md` (generated; models, columns, indexes)
- `project-design/appendices/migration-catalog.md` (generated; migration application order)
- `project-design/appendices/env-and-config-matrix.md` (generated; storage environment keys)
- `project-design/appendices/api-route-matrix.md` (generated; backup and search routes)

## 10. Change history

- 2026-11-03 — Initial canonical extraction. Records the actual UoW/outbox/audit behavior, replica adoption, Redis fallback, shard arithmetic, read-model no-op handlers, missing retention, missing keyset pagination, missing `gateway_wire_logs`, missing disk spool and zero DB log metrics. See `project-design/TRACKER.md`.

## 11. Two-machine routing and realtime additions (2026-11-03)

- `readThroughReplica` and `readThroughReplicaOrPrimary` record the serving store in an `AsyncLocalStorage` context. The core middleware emits `x-pg-served-by` (and the requested `x-pg-min-lsn` watermark) on the response. Checkout initiate/confirm also emit `x-pg-lsn` with the post-commit flush LSN.
- The admin merchant list now uses the replica-aware helper, so the T1/T3/T4/T5/T6/T7/T8 routing gate can prove list reads hit a replica and T2 falls back to primary.
- `AuditShipperWorker` no longer computes `prev_hash`/`row_hash` in Node. Inserts omit both columns and the audit database trigger computes them under `pg_advisory_xact_lock(994001)`; `RETURNING` supplies the actual hashes.
- `verifyHashChainIntegrity` reads `before_json::text`/`after_json::text` so it verifies the trigger canonical form.
- Attempt transitions are bridged to `realtime:attempt` on the existing Redis-backed invalidation bus; checkout SSE and merchant POS streams subscribe to it while retaining the database poll fallback.

## Gap resolutions (2026-11-05)

- **UTC pinning (GAP-030, RESOLVED with a residual).** `core-back/lib/storageEngine/utcSession.ts` pins every connection the storage engine opens to `timezone=UTC` through the connection-URL startup option `options=-c timezone=UTC` (`pinUtcInConnectionUrl`; any other `timezone` option already in the URL is replaced, because node-postgres lets the connection string override explicit config). `createUtcPinnedClient` builds the Prisma client, the audit and log pools and the leader-election connection use the same pinned URL, and `readSessionTimeZone` reports `SHOW timezone`. The deploy provisioner also writes `timezone = 'UTC'` and `log_timezone = 'UTC'` into every cluster's `postgresql.conf` (see `deploy.storage`). Residual: `core-back/prisma/client/base.ts` is still unpinned (tracked in the gap list above).
- **Redis velocity failure policy (GAP-031, RESOLVED).** `REDIS_VELOCITY_FAILURE_POLICY` (parsed by `parseVelocityFailurePolicy`, wired in `createStorageEngine`, overridable with `velocityFailurePolicy`) defines what the Redis velocity counter does when Redis is unreachable, errors or exceeds the command timeout. `local-fallback` (default) fails open degraded: the window is counted in this node's memory, so limits still apply per node and are lost on restart. `fail-open` allows without counting (empty `windowStats`). `fail-closed` throws `VelocityUnavailableError` so the caller refuses the attempt. `onVelocityDegraded` is invoked with the policy and the error. Velocity is a risk signal, not a ledger invariant, so the default does not stop payments during an outage; use `fail-closed` only when a missed limit is worse than an outage. Tests: `core-back/test/storage-engine/velocity-failure-policy.test.ts`.
- **Leader election (GAP-012).** `StorageEngine.leaderElection` is a `PgAdvisoryLeaderElection` built from the primary URL (see `core.workers` for the semantics and the PgBouncer transaction-pooling caveat); it is closed with the engine.
