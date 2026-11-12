---
id: platform.runtime
title: Runtime and Configuration
status: partial
confidence: high
last_verified: 2026-11-10
verified_against: d695518+working-tree
code:
  - core-back/index.ts
  - core-back/lib/env/index.ts
  - core-back/lib/db/connectionConfig.ts
  - core-back/prisma/client/index.ts
  - core-back/lib/storageEngine/index.ts
  - core-back/engine/workers/productionRuntime.ts
  - core-back/lib/invalidationBus/index.ts
  - core-back/lib/requestLogger/index.ts
  - core-back/lib/rawBody/index.ts
  - admin-back/lib/env/index.ts
  - merchant-back/lib/env/index.ts
  - checkout-back/lib/env/index.ts
  - fake-rails-back/lib/env/index.ts
  - deploy/lib/configSchema.ts
  - deploy/deploy.ts
design_sources:
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#21-service-roles-boundaries-and-security-constraints
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#91-the-nine-governing-state-machine-rules
  - design/90-archive/delivery-logs/opencode_technical_delivery_design.md#28-delivery-run-4--postgresql-18-storage-engine-backups-and-horizontal-scaling
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#2-segment-1--the-core-back-storage-driver-engine-core-backlibstorageengine
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#11-high-level-system--storage-topology-diagram
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#6-ordered-14-step-multi-host-deployment-pipeline
tests:
  - core-back/test/db-connection-config.test.ts
  - core-back/test/runtime/raw-body.test.ts
  - core-back/test/runtime/production-adapters.test.ts
  - core-back/test/runtime/rotating-refresh-token.test.ts
  - core-back/test/worker-runtime-health.test.ts
  - core-back/test/storage-engine/engine-factory.test.ts
  - core-back/test/storage-engine/cache-velocity.test.ts
  - admin-back/test/env-isolation.test.ts
  - merchant-back/test/env-isolation.test.ts
  - checkout-back/test/env-isolation.test.ts
  - admin-back/test/security-regressions.test.ts
  - merchant-back/test/security-regressions.test.ts
  - checkout-back/test/security-regressions.test.ts
gaps:
  - core-back startup does not call ensureSchemaVersion; only seeders enforce schema version 37.
- `merchant_reports.policy` (Platform Settings, `settings:write`) is the staff-managed merchant reporting switch. `enabled` controls the runner/Studio; `assetsEnabled` controls merchant asset bundles. Missing values fall back to enabled/allowed.
  - LOG_LEVEL is declared but not used by the console or access logger.
  - WORKER_CONCURRENCY and WORKER_REQUEST_TIMEOUT_MS are accepted but not passed to the production worker runtime.
  - Console request-log correlation uses a separate short id from x-request-id.
  - The schema version check is seed-time only; a stale database can boot the API.
  - Redis is optional; without it invalidation is process-local and velocity/cache use in-memory adapters.
---

# Runtime and Configuration

## 1. Purpose and scope

This part describes how the platform processes start, how configuration is read and validated, in which order core composes its TLS server, storage engine and workers, how health and degradation are reported, how request IDs and logging work, how the invalidation bus is wired, and which runtime/deploy flags exist.

It covers `core-back` startup in detail and summarizes the edge and Fake Rails env surfaces. Full key-by-key values are generated in `project-design/appendices/env-and-config-matrix.md`; this part records the grouping, defaults, consumers and known unused keys.

## 2. Design intent (extracted and synthesized from ./design)

The historical design requires:

- A private-LAN `core-back` process that reads its database and KMS configuration only from its own env.
- Edge processes with no database or KMS variables; their only upstream configuration is the core URL pool and their mTLS material.
- PostgreSQL 18 through `@prisma/adapter-pg` and `pg`; no MySQL/MariaDB runtime path.
- A unified storage engine with `UnitOfWork`, `ReadStore`, cache/velocity, audit and log ports.
- Durable workers that start with core and claim work with `FOR UPDATE SKIP LOCKED`.
- A queue-drainability guard: queue-only routes must not accept work when no worker can drain it.
- Redis Pub/Sub invalidation across core nodes when Redis is available, with a local fallback.
- Request IDs propagated from edge to core and returned in responses.
- Dedicated audit and log databases; logging must never block or fail a payment.
- Build-time UI flags injected by the deploy engine and runtime-config values written into the deployed release.

## 3. As-built architecture

### 3.1 Environment loader

`core-back/lib/env/index.ts` defines a `z.strictObject` schema. The loader only reads keys that exist in the schema; unrelated process env keys are ignored. Values are parsed through:

- `booleanFromEnvironment` for `true/1/yes` and `false/0/no`.
- `postgresUrl`/`optionalPostgresUrl` for PostgreSQL URLs only.
- `filePath` for non-empty cert paths.
- Coercion and defaults for numeric limits.

The exported `env` is a Proxy that parses lazily and caches outside tests. In `NODE_ENV=test` the cache is bypassed so multiple test files can boot different configurations in one process. If the test environment is missing configuration, the loader prints one warning and returns a full fallback object with a local test database, test master key and worker defaults; non-test invalid configuration prints the invalid key names and exits with code 1.

`envSummary()` redacts `DATABASE_URL`, `LEADER_ELECTION_DATABASE_URL`, `KMS_MASTER_KEY` and `MTLS_SERVER_KEY_PATH`. Replica/audit/log URLs and other certificate paths are not redacted by that helper. It is not an HTTP route.

Edge env loaders follow the same pattern: strict-ish Zod object, cached outside tests, explicit `process.exit(1)` on invalid production config. `admin-back` additionally parses `CORE_BACK_URLS` into a de-duplicated HTTPS list.

### 3.2 Full core environment surface

#### Core process and network

| Key | Default | Consumer |
| :--- | :--- | :--- |
| `PORT` | `4000` | TLS listener |
| `HOST` | `127.0.0.1` | TLS listener |
| `NODE_ENV` | `development` | test cache behavior, `import.meta.main` guard |
| `TRUST_PROXY` | `false` | Express `trust proxy` |
| `LOG_LEVEL` | `info` | Declared only; no logger reads it |

#### Database, storage and cache

| Key | Default | Consumer |
| :--- | :--- | :--- |
| `DATABASE_URL` | required | Prisma primary |
| `LEADER_ELECTION_DATABASE_URL` | unset | session-scoped leader election; required when `PGBOUNCER_ENABLED=true` |
| `PGBOUNCER_ENABLED` | `false` | deploy sets it when the pooler fronts PostgreSQL; enforces the session endpoint |
| `DATABASE_REPLICA_URLS` | empty | read replicas |
| `AUDIT_DATABASE_URL` | unset | dedicated audit store |
| `REPORT_READONLY_DATABASE_URL` | unset | dedicated staff report read-only pool; falls back to a replica or `DATABASE_URL` |
| `REPORT_READONLY_SERVED_BY` | `primary-readonly-tx` | honest serving label for the report executor (`replica` only after confirming a physical replica) |
| `REPORT_MERCHANT_READONLY_DATABASE_URL` | unset | optional dedicated merchant report read-only pool; falls back to the report pool/`DATABASE_URL` |
| `MERCHANT_REPORT_EXECUTE_PER_HOUR` / `MERCHANT_REPORT_VERIFY_PER_HOUR` | `60` / `30` | per-merchant hourly limits |
| `MERCHANT_REPORT_DAILY_DB_TIME_MS` | `600000` | per-merchant daily execution-time budget |
| `MERCHANT_REPORT_MAX_CODES` / `MERCHANT_REPORT_MAX_VERSIONS_PER_CODE` | `50` / `20` | merchant Studio storage quotas |
| `REPORT_ASSET_STORAGE_DIR` | `.report-assets` | persistent report asset directory; set outside the release tree |
| `LOG_DATABASE_URL` | unset | dedicated log sink |
| `REDIS_URL` | unset | cache/velocity and invalidation |
| `REDIS_NODES` | empty | first node used when `REDIS_URL` is absent |
| `READ_REPLICA_MAX_LAG_MS` | `2000` | replica read eligibility |
| `STORAGE_QUERY_TIMEOUT_MS` | `5000` | storage/transaction timeout |
| `STORAGE_LOG_BUFFER_MAX` | `5000` (max 100000) | log buffer |
| `STORAGE_LOG_FLUSH_INTERVAL_MS` | `250` (max 60000) | log flush |
| `STORAGE_SHARD_COUNT` | `16` (max 256) | initial routing width of system GL accounts (wallets start at 1) |

#### mTLS and backup control plane

| Key | Default | Consumer |
| :--- | :--- | :--- |
| `MTLS_CA_CERT_PATH` | required | client cert verification |
| `MTLS_SERVER_CERT_PATH` | required | TLS server |
| `MTLS_SERVER_KEY_PATH` | required | TLS server |
| `KMS_MASTER_KEY` | required, min 16 chars | vault/session key derivation |
| `BACKUP_DAEMON_URL` | unset | backup control client |
| `BACKUP_DAEMON_CA_CERT_PATH` | unset | backup client mTLS |
| `BACKUP_DAEMON_CLIENT_CERT_PATH` | unset | backup client mTLS |
| `BACKUP_DAEMON_CLIENT_KEY_PATH` | unset | backup client mTLS |
| `BACKUP_DAEMON_TIMEOUT_MS` | `15000` (max 120000) | backup call timeout |

#### Shared object & asset storage (schema v36)

| Key | Default | Consumer |
| :--- | :--- | :--- |
| `OBJECT_STORAGE_DAEMON_URL` | unset; configure the shared node in production. Without it a production core boots but every storage operation returns `503 STORAGE_UNAVAILABLE`; multi-node refuses to boot. | `RemoteMtlsBlobStore` (all core nodes) |
| `OBJECT_STORAGE_TLS_CA_PATH` / `_CLIENT_CERT_PATH` / `_CLIENT_KEY_PATH` | unset | client mTLS |
| `OBJECT_STORAGE_DAEMON_TIMEOUT_MS` | `30000` (max 120000) | blob requests |
| `OBJECT_STORAGE_ROOT_DIR` | `/tmp/pg-object-storage-dev` (dev) | `FsBlobStore` fallback (development only; production never writes local disk) |
| `OBJECT_STORAGE_ALLOW_INSECURE_HTTP` | `false` | explicit local-test-only HTTP opt-in; refused in production deploy validation |
| `OBJECT_STORAGE_KEK_KEYRING` | unset (dev derives from `DATABASE_URL`) | DEK wrap/unwrap; format `v1:<64 hex>[,v2:<64 hex>]` |
| `OBJECT_STORAGE_ACTIVE_KEK_VERSION` | `1` | new DEK wraps |
| `OBJECT_STORAGE_TRASH_RETENTION_DAYS` | `7` | trash purge |
| `OBJECT_STORAGE_GC_GRACE_HOURS` | `24` | last-lock-release grace |
| `CLUSTER_CORE_NODE_COUNT` | `1` | shared-storage boot guard |
| `WORKER_OBJECT_STORAGE_ENABLED` | `true` | maintenance worker |
| `WORKER_OBJECT_STORAGE_INTERVAL_MS` | `60000` | maintenance worker |
| `WORKER_OBJECT_STORAGE_BATCH_SIZE` | `25` | AV/scrub batch |

A production core without a configured daemon stays bootable with an unavailable store; storage-backed routes return 503. A multi-node core refuses to boot (`OBJECT_STORAGE_DAEMON_URL_REQUIRED`) when
`NODE_ENV=production` or the core-node count is above one and no daemon URL is
configured.

#### Workers

| Key | Default | Consumer |
| :--- | :--- | :--- |
| `WORKER_ENABLED` | `true` | master worker switch; boot refuses false |
| `WORKER_POLL_INTERVAL_MS` | `5000` | generic worker interval |
| `WORKER_BATCH_SIZE` | `50` (max 1000) | generic worker batch |
| `WORKER_CONCURRENCY` | `4` (max 100) | Declared only; not passed to the production runtime |
| `WORKER_MAX_ATTEMPTS` | `3` | inbox/job retry ceiling |
| `WORKER_REQUEST_TIMEOUT_MS` | `15000` | Declared only in the current composition |
| `WORKER_RESCREEN_INTERVAL_MS` | `86400000` | periodic screening |
| `WORKER_KYB_EXPIRY_INTERVAL_MS` | `21600000` | KYB expiry worker |
| `WORKER_KYB_EXPIRY_BATCH_SIZE` | `200` (max 10000) | KYB expiry batch |
| `WORKER_KYB_SCAN_ENABLED` / `WORKER_KYB_SCAN_INTERVAL_MS` / `WORKER_KYB_SCAN_BATCH_SIZE` | `true` / `60000` / `20` | KYB scan worker (AUTO-06) |
| `WORKER_STATEMENT_SCHEDULE_ENABLED` / `WORKER_STATEMENT_SCHEDULE_INTERVAL_MS` / `STATEMENT_SCHEDULE_GRACE_MINUTES` / `STATEMENT_SCHEDULE_LOOKBACK_SLOTS` | `true` / `300000` / `120` / `7` | statement schedule alerts (AUTO-07) |
| `WORKER_CONSISTENCY_AUDIT_ENABLED` / `WORKER_CONSISTENCY_AUDIT_INTERVAL_MS` / `CONSISTENCY_AUDIT_REPAIR` | `true` / `3600000` / `false` | slot counter audit (AUTO-12) |
| `WORKER_MERCHANT_WEBHOOK_ENABLED` / `WORKER_MERCHANT_WEBHOOK_INTERVAL_MS` / `WORKER_MERCHANT_WEBHOOK_BATCH_SIZE` | `true` / `2000` / `50` | merchant webhook delivery and relay fan-out (AUTO-34) |
| `MERCHANT_WEBHOOK_TIMEOUT_MS` / `MERCHANT_WEBHOOK_CONCURRENCY` / `MERCHANT_WEBHOOK_ALLOW_INSECURE` / `MERCHANT_WEBHOOK_DISABLE_AFTER_DAYS` / `MERCHANT_WEBHOOK_ROTATION_OVERLAP_HOURS` | `10000` / `8` / `false` / `5` / `24` | webhook egress and failure policy |
| `WORKER_REGULATORY_REPORT_ENABLED` / `WORKER_REGULATORY_REPORT_INTERVAL_MS` | `true` / `3600000` | regulatory report drafting (AUTO-16) |
| `REGULATORY_REPORT_MAX_PERIODS` / `REGULATORY_REPORT_MAX_BATCH_LINES` / `REGULATORY_REPORT_REMINDER_BUSINESS_DAYS` | `2` / `5000` / `3` | catch-up depth, batch cap, filing reminder lead |
| `WORKER_AUDIT_ANCHOR_ENABLED` / `WORKER_AUDIT_ANCHOR_INTERVAL_MS` | `true` / `86400000` | audit-chain anchor worker (AUTO-27; needs the dedicated audit database) |
| `AUDIT_ANCHOR_SEGMENT_ROWS` / `AUDIT_ANCHOR_MAX_SEGMENTS_PER_TICK` / `AUDIT_ANCHOR_KEY_ID` | `5000` / `40` / `audit-anchor-v1` | anchor verification bounds and vault signing key |
| `PLATFORM_MONITOR_BACKUP_MAX_FULL_AGE_MS` / `PLATFORM_MONITOR_BACKUP_DRILL_MAX_AGE_MS` | `129600000` / `691200000` | backup freshness limits (AUTO-27) |
| `WORKER_RETENTION_ENABLED` | `false` | retention worker |
| `WORKER_RETENTION_INTERVAL_MS` | `3600000` | retention cadence |
| `WORKER_RETENTION_BATCH_SIZE` | `500` (max 10000) | retention batch |
| `WORKER_LEDGER_CHECKPOINT_ENABLED` | `true` | per-shard ledger checkpoint worker |
| `WORKER_LEDGER_CHECKPOINT_INTERVAL_MS` | `30000` | checkpoint cadence |
| `WORKER_LEDGER_CHECKPOINT_BATCH_SIZE` | `50` (max 10000) | shards captured per pass |
| `LEDGER_CHECKPOINT_MIN_LINES` | `5000` | pending lines that trigger a checkpoint |
| `LEDGER_CHECKPOINT_MAX_AGE_MS` | `900000` | age after which any pending shard is checkpointed |
| `LEDGER_SHARD_AUTO_REPAIR_ENABLED` | `true` | automatic repair of a persistently failing PARITY shard with an intact sequence |
| `LEDGER_SHARD_AUTO_REPAIR_MIN_FAILURES` | `3` | consecutive failed proofs before an automatic repair |
| `LEDGER_SHARD_AUTO_REPAIR_MAX_ABS_DRIFT` | `100` | largest correction an automatic repair may apply |
| `WORKER_LEDGER_SHARD_SCALER_ENABLED` | `true` | hot-account shard scaler |
| `WORKER_LEDGER_SHARD_SCALER_INTERVAL_MS` | `30000` | scaler sampling cadence |
| `LEDGER_SHARD_SCALER_DRY_RUN` | `false` | `true` = audit proposals only (nothing is widened); the default lets the scaler widen hot accounts |
| `LEDGER_SHARD_UP_LINES_PER_SEC` | `150` | hot threshold, lines per second per shard |
| `LEDGER_SHARD_MAX_WIDTH` | `64` (max 256) | widest routing width the scaler assigns |
| `LEDGER_SHARD_COOLDOWN_MS` | `600000` | minimum time between two scalings of one account |
| `RETENTION_DRY_RUN` | `false` | retention dry run |
| `WORKER_BACKGROUND_JOBS_ENABLED` | `true` | durable job queue; boot refuses false |
| `WORKER_BACKGROUND_JOBS_INTERVAL_MS` | `2000` | queue drain cadence |
| `WORKER_BACKGROUND_JOBS_BATCH_SIZE` | `10` (max 1000) | queue batch |
| `WORKER_BACKGROUND_JOBS_LEASE_SECONDS` | `300` | claimed-job lease |
| `WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS` | `300000` | `/health` degradation threshold |

#### Notifications

| Key | Default | Consumer |
| :--- | :--- | :--- |
| `NOTIFICATION_WEBHOOK_URL` | unset | SMS/email aggregator |
| `NOTIFICATION_WEBHOOK_TIMEOUT_MS` | `5000` (max 120000) | delivery timeout |

Without a webhook URL the notification transport logs the delivery and reports `SENT` rather than `DELIVERED`.

#### Fake Rails and synthetic data

| Key | Default | Consumer |
| :--- | :--- | :--- |
| `FAKE_RAILS_ENABLED` | `false` | seeder safety gate |
| `FAKE_RAILS_ALLOW_IN_PRODUCTION` | `false` | seeder/service guard |
| `IS_TEST_SERVER` | `false` | test-server declaration |
| `FAKE_RAILS_PUBLIC_BASE_URL` | unset | seeder and seedFakeRails |
| `ALLOW_FAKE_RAILS_HOSTS` | `false` | scoped SSRF exception |
| `FAKE_RAILS_ALLOWED_HOSTS` | empty | scoped SSRF exception and seeders |
| `FAKE_RAILS_SEEDER_TOKEN` | unset (min 16) | bulk seed handshake |
| `FAKE_RAILS_ALLOWED_CIDRS` | empty | Declared; not consumed by the engine SSRF guard |

The synthetic seeder and Fake Rails seed script read several of these directly from `process.env`, not through the `env` proxy. `KYB_SCANNER_MODE` is also read directly by `core-back/lib/kybScan.ts` at upload time (the upload path only ever sets `CLEAN` for `eicar`; `clamd` leaves the document `PENDING` for the `KybScanWorker`). It is part of `envSchema` too (with `KYB_CLAMD_ADDRESS`, `KYB_CLAMD_TIMEOUT_MS`, `KYB_RESCAN_DAYS`, `KYB_SCAN_MAX_ATTEMPTS`, `WORKER_KYB_SCAN_*`, `PLATFORM_MONITOR_KYB_SCAN_MAX_AGE_MS`) for the worker (AUTO-06).

### 3.3 Edge environment groups

| Edge | Key group |
| :--- | :--- |
| `admin-back` | `NODE_ENV`, `PORT` (`4101`), `ADMIN_BIND_HOST` (`127.0.0.1`), `CORE_BACK_URL`, optional `CORE_BACK_URLS`, `MTLS_CLIENT_CERT_PATH`, `MTLS_CLIENT_KEY_PATH`, `MTLS_CA_CERT_PATH`, `CORE_REQUEST_TIMEOUT_MS` (`60000`), `TRUSTED_PROXY_CIDRS`, `ADMIN_LAN_CIDRS`, `ADMIN_AUTHORITY_HINTS`, `MAX_JSON_BODY_BYTES` (`4194304`), `MAX_UPLOAD_BYTES` (`20971520`), `UPLOAD_ALLOWED_MIME`, `ADMIN_RATE_LIMIT_MAX/WINDOW_MS`, `AUTH_RATE_LIMIT_MAX/WINDOW_MS`, `RECONCILIATION_TIMEOUT_MS` |
| `merchant-back` | `PORT` (`4102`), `BIND_HOST` (`0.0.0.0`), core URL(s), mTLS paths, `CORE_REQUEST_TIMEOUT_MS` (`30000`), `TRUSTED_PROXY_CIDRS` (default loopback only), `MAX_JSON_BODY_BYTES` (`2097152`), `MAX_UPLOAD_BYTES` (`10485760`), `UPLOAD_ALLOWED_MIME`, `PG_LIVE_TOKEN_PREFIX` (`pg_live_`), `AUTH_RATE_LIMIT_*`, `API_RATE_LIMIT_*`, `EXTERNAL_RATE_LIMIT_*` (each with `*_WINDOW_MS`), `TOKEN_MAX_SCOPES` (`20`), `TOKEN_MAX_TTL_DAYS` (`365`), `TOKEN_DEFAULT_TTL_DAYS` (`90`), `UPLOAD_RATE_LIMIT_MAX`, `CORS_ALLOWED_ORIGINS`, `POS_STREAM_TIMEOUT_MS` (`900000`) |
| `checkout-back` | `PORT` (`4103`), `BIND_HOST` (`0.0.0.0`), core URL(s), mTLS paths, `CORE_REQUEST_TIMEOUT_MS` (`30000`), `TRUSTED_PROXY_CIDRS`, `MAX_JSON_BODY_BYTES` (`1048576`), `MAX_INBOUND_BODY_BYTES` (`1048576`), `CHECKOUT_FRONT_BASE_URL`, `CHECKOUT_FRONT_STATUS_PATH` (`/pay/status`), `PAY_RATE_LIMIT_*`, `INBOUND_RATE_LIMIT_*` (each with `*_WINDOW_MS`), `CORS_ALLOWED_ORIGINS` |
| `fake-rails-back` | `HOST` (`127.0.0.1`), `PORT` (`4104`), `LOG_LEVEL`, `FAKE_RAILS_ENABLED` (`true`), `FAKE_RAILS_ALLOW_IN_PRODUCTION`, `FAKE_RAILS_PUBLIC_BASE_URL` (`http://127.0.0.1:8444`), `FAKE_RAILS_DATA_DIR` (`shared/data`), `CORE_INBOUND_BASE_URL` (`http://127.0.0.1:4103/api/v1/inbound`), admin credentials, JWT secret, seeder token, allowed CIDRs, webhook timeout, max body, portal rate limits |

The Fake Rails loader refuses to start without a strong non-default admin password, a seeder token and a JWT secret, and refuses production unless `FAKE_RAILS_ALLOW_IN_PRODUCTION=true`.

### 3.4 Startup order

`core-back/index.ts` `start()` executes in this order:

1. **Queue-drainability assertion.** `assertBackgroundJobQueueDrainable` throws if `WORKER_ENABLED` or `WORKER_BACKGROUND_JOBS_ENABLED` is false. The statement upload and dispute intake are queue-only routes, so booting without a drain would strand accepted work.
2. **Redis invalidation transport.** `configureRedisInvalidation()` takes `REDIS_URL` or the first `REDIS_NODES` entry, creates a publisher and a duplicate subscriber, connects both, and configures the global `invalidationBus`. On failure it logs a warning and disables the transport.
3. **TLS server object.** `createHttpsServer()` calls `createApp()`, reads the server key/cert/CA (failing fast if missing), creates the plain HTTP server and the TLS server, bridges `secureConnection` into the HTTP server, installs error handlers, and returns a small wrapper with `listen`, `close`, `address` and `on`.
4. **Storage engine.** `getStorageEngine()` creates the process singleton: primary Prisma client, replicas, read store, unit of work, cache/velocity adapter, audit driver and log sink. The LSN monitor starts inside the read store.
5. **Platform runtime wiring.** `setPlatformStorage(storage)` gives the rail runtime access to the storage engine; `setAccessLogSink(storage.logSink)` routes access logs to the dedicated log database when configured.
6. **Worker runtime.** When `WORKER_ENABLED` is true, `createProductionWorkerRuntime()` builds the worker set with the Prisma client, storage engine, intervals, batch sizes, retention flags and background-job settings, then starts every worker.
7. **Listen.** The TLS server listens on `HOST:PORT`; the callback logs the TLS 1.3 client-certificate requirement.
8. **Signal handlers.** `SIGTERM` and `SIGINT` stop workers, clear the access log sink and platform storage, close the invalidation transport, shut down the storage engine (flushing logs and closing pools) and close the server.

The storage engine is constructed before `listen`, but after the server object is created. If `listen` fails, the worker runtime has already been started and is not stopped by the rejection path; that is a narrow startup-failure window.

### 3.5 Schema version check

`core-back/prisma/schemaVersion.ts` defines `REQUIRED_SCHEMA_VERSION = 37`. `core-back/prisma/client/index.ts` exports `ensureSchemaVersion()` which connects, runs:

```sql
SELECT "version" FROM "schema_versions" WHERE "id" = 1
```

and throws if the version is not 37. The check is invoked by `prisma/seed.ts`, `prisma/seedFakeRails.ts` and `prisma/syntheticSeeder/index.ts`. It is **not** invoked by `core-back/index.ts`, so the API can boot against a stale schema and fail later at query time. Migration deployment is an external deploy step (`bunx prisma migrate deploy`).

### 3.6 Worker composition

`createProductionWorkerRuntime()` wires real ports:

- `ExpirySweeperWorker` with an inquiry port backed by `platform.engine.inquire`.
- `PollWorker` with the same inquiry port.
- `InboundInboxWorker` with a handler that resolves the channel and calls `platform.engine.verifyCallback`.
- `OutboxNotificationWorker` with a notification transport (webhook or log).
- `LedgerInvariantWorker`.
- `JoinRequestExpiryWorker`.
- `PeriodicScreeningWorker` using `platform.screening`.
- `KybExpiryWorker` with its own interval and batch.
- `RetentionWorker` only when retention is enabled.
- `OutboxRelayWorker` and `AuditShipperWorker` only when a storage engine is supplied; the audit shipper additionally requires a `DedicatedAuditDatabaseDriver`, which exists only when `AUDIT_DATABASE_URL` is set.
- `BackgroundJobWorker` when background jobs are enabled, with `RECONCILIATION_RUN` and `ADJUSTMENT_EXECUTION` handlers.

Workers are in-process. Non-singleton workers rely on database claim semantics (`FOR UPDATE SKIP LOCKED`, conditional terminal updates and leases). Singleton workers (`ExpirySweeper`, `InboundInbox`, `JoinRequestExpiry`, `KybExpiry`, `LedgerInvariant`, `PeriodicScreening`, `Retention`, `LedgerCheckpoint`, `LedgerShardScaler`) additionally hold a PostgreSQL session advisory lock through `LEADER_ELECTION_DATABASE_URL`. That endpoint is a PgBouncer `pgw_session` alias with `pool_mode=session` when `PGBOUNCER_ENABLED=true` (or a direct PostgreSQL URL); core refuses the transaction-pooled `DATABASE_URL`, probes the session at boot and re-proves backend/lock ownership on every tick (fail closed).

### 3.7 Health and degradation

`GET /health` on the core listener:

- Computes `workersEnabled = WORKER_ENABLED && WORKER_BACKGROUND_JOBS_ENABLED`.
- Reads `background_jobs` count and oldest `QUEUED` age with `readBackgroundJobQueueHealth`.
- Treats a database read failure as `queueReachable = false` and returns a zeroed queue with `error: "QUEUE_HEALTH_UNAVAILABLE"`.
- Degrades when workers are disabled, the queue is unreachable, or the oldest queued job exceeds `WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS`.
- Always responds HTTP 200 with `{ msg, status, service, queue }`.

It does not probe the storage engine, replicas, Redis, audit/log databases, backup daemon or external gateways. It also does not expose counts of `RUNNING`/dead jobs, only `QUEUED` and oldest age.

### 3.8 Request IDs and logging

`requestIdMiddleware`:

- Accepts an incoming `x-request-id` only if it matches `^[A-Za-z0-9._:-]{1,128}$`.
- Otherwise generates a UUID.
- Stores it on `request.requestId` and returns it as the `x-request-id` response header.

`requestLoggerMiddleware` creates a console logger with its own short six-character id and records request-scoped info/warn/error lines. It logs one header line with timestamp, method, path, status, duration, content length and IP. On response finish it writes an `http_access_logs` record through the access-log sink:

- `requestId` is the middleware `x-request-id` value (not the console short id).
- `channel` is derived from the path: `/internal/admin` -> `admin`, `/internal/merchant` -> `merchant`, `/internal/checkout` -> `checkout`, otherwise `webhook`.
- `routePattern` is `req.route?.path ?? req.path`.
- `statusCode`, duration, `dbQueries: 0` and `dbDurationMs: 0`.
- `actorId: null`; no actor is attached to the access record.
- `clientIp` from `x-real-client-ip` (validated as an IP by `edgeReportedClientIp`) first, then `req.ip`.

`LOG_LEVEL` is not consulted. Console correlation and access-log correlation can differ because of the separate short id. The access log write is wrapped in a try/catch and never fails the request.

The dedicated log sink buffers step logs and access logs, flushes every 250 ms, caps the step buffer at `STORAGE_LOG_BUFFER_MAX`, drops access records when the buffer is full, and inserts up to 500 rows per flush. When `LOG_DATABASE_URL` is absent, step logs are retained in a bounded in-memory map for attempt lookups and access logs are discarded.

### 3.9 Raw body handling

`rawBodyMiddleware` is mounted before JSON parsing and applies to:

- `/internal/checkout/inbound` and its subpaths.
- `/internal/merchant/onboarding/kyb-documents`.
- `/internal/admin/reconciliation/upload`.
- `/internal/admin/join-requests/:id/kyb-documents` by pattern.

The collector is `express.raw({ type: () => true, limit: "25mb" })`. Everything else uses JSON/urlencoded parsers with a 1 MiB core limit.

### 3.10 Invalidation bus

`core-back/lib/invalidationBus/index.ts` exports a process singleton `InvalidationBus`:

- Local `EventEmitter` plus an explicit subscription map.
- Namespace default `payment-gateway`; channel format `${namespace}:invalidation:${topic}`.
- Trailing-`*` wildcard subscriptions (`credential:*`, `gateway:*`).
- Cross-node de-duplication by event id with a 2048-id seen set.
- Topics used in production: `attempt:transition`, `credential:<id>`, `gateway:<id>`, `configuration:<scope>`.
- `ConsumerRegistry` subscribes to `credential:*` and invalidates cached consumers; admin gateway activation publishes gateway invalidation; governance publishes attempt transitions.

When Redis is configured, publisher/subscriber clients are connected at startup. A publish does both local delivery and Redis publish; a received Redis message is ignored unless its namespace matches and its id is unseen. When Redis is absent or fails to connect, invalidation is process-local only.

### 3.11 Deploy-injected runtime flags

The deploy engine injects admin UI flags rather than requiring a committed frontend `.env`:

- `ADMIN_SHOW_CHECKLISTS` (optional) and `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST` (default true) control checklist visibility. `adminChecklistsVisible()` prefers the former.
- `ADMIN_SHOW_HELP_PANELS` (default true) controls help panels.
- Build constants `VITE_SHOW_CHECKLISTS`, `VITE_SHOW_SNAPSHOT_EXPORT_CHECKLIST` and `VITE_SHOW_HELP_PANELS` are injected into the `admin-front` build.
- Runtime config `showChecklists`, `showSnapshotExportChecklist` and `showHelpPanels` is written into the deployed admin release and takes precedence at boot.

These are deploy/frontend flags; they are not core-back env keys.

## 4. Contracts and invariants

1. **Invalid production config does not boot.** The env loader exits with code 1 and prints only the failing key names.
2. **Queue-only routes require a drain.** Core refuses to boot when workers or background jobs are disabled.
3. **The storage engine is a singleton per process.** `getStorageEngine()` and `setStorageEngine()` are the only supported lifecycle.
4. **No log write may fail a payment.** Step/access log writes are best-effort; failures are swallowed.
5. **The raw body is preserved before JSON parsing.** Webhook signatures and uploaded document bytes must be exact.
6. **A request id is always returned.** Invalid or missing client values are replaced with a UUID.
7. **Redis is never authoritative for money.** When Redis is unavailable the cache/velocity adapter falls back to memory and invalidation stays local.
8. **Schema version 37 is the contract.** Seeders enforce it; migrations are deployed separately.
9. **Workers are stateless across nodes.** Coordination is by database claims, not by an in-memory scheduler.
10. **The admin UI flags are deployment-owned.** A source build uses the frontend defaults; a deployed build receives the deploy engine's values.

## 5. Data / API / config / deployment surface

### 5.1 Runtime surfaces

- core TLS listener: `HOST:PORT`.
- core health: `GET /health`.
- core channel healths: `GET /internal/{admin,merchant,checkout}/health`.
- edge healths: `GET /health` on `4101`, `4102`, `4103`.
- Fake Rails healths: `GET /health`, `GET /hosted/health`.
- backup daemon: `GET /health`, `/v1/overview`.
- storage ports: primary, replicas, cache, audit, logs, unit of work.
- invalidation channels: `payment-gateway:invalidation:<topic>`.

### 5.2 Startup dependencies

| Dependency | Required | Failure behavior |
| :--- | :--- | :--- |
| mTLS server key/cert/CA | Yes | Startup throws with a clear message |
| PostgreSQL primary | Yes | Startup succeeds until a query; `/health` reports queue unavailable |
| Redis | No | Warning, memory cache and local invalidation |
| Audit DB | No | Audit store is null; audit shipping is not started |
| Log DB | No | Step logs stay in memory; access logs are dropped |
| Backup daemon | No | Backup routes return 503 |
| Notification webhook | No | Log transport reports SENT |
| Fake Rails | No | Only required by synthetic seeding/seeding routes |
| Schema version 37 | Yes at seed time | Seeders fail; server boot does not check |

### 5.3 Config consumers outside the env proxy

- `core-back/lib/kybScan.ts` reads `KYB_SCANNER_MODE` directly.
- `core-back/prisma/syntheticSeeder/**` and `prisma/seedFakeRails.ts` read Fake Rails variables directly.
- `deploy/deploy.ts` reads the deploy config and injects frontend build/runtime flags.
- The backup daemon has its own env schema in `deploy/backup-daemon/src/config.ts`; it is not validated by the core schema.

## 6. Operational usage

### 6.1 Start core locally

```bash
cd core-back
bun run generate-mtls-certs
export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith
bun run migrate-deploy
bun run db-seed
bun run start
```

`db-seed` calls `ensureSchemaVersion()`, so a fresh database that has not had migrations applied fails before seeding. `bun run start` does not perform that check.

### 6.2 Configure storage

- Set `DATABASE_URL` to the primary URL.
- Set `DATABASE_REPLICA_URLS` to a comma-separated list to enable replica reads.
- Set `AUDIT_DATABASE_URL` and `LOG_DATABASE_URL` to enable the dedicated adapters; otherwise audit shipping is skipped and log records stay in memory.
- Set `REDIS_URL` or `REDIS_NODES` for cross-node cache/velocity and invalidation.
- `STORAGE_SHARD_COUNT` is only the INITIAL width of system GL accounts (default 16, range 1..256, the same range in core env, the DB check and the deploy schema). The shard scaler widens hot accounts afterwards; the scaler is ON by default (`LEDGER_SHARD_SCALER_DRY_RUN=false`) with conservative thresholds; calibrate `LEDGER_SHARD_UP_LINES_PER_SEC` on the target hardware, and set the flag to `true` to watch proposals without widening anything.

### 6.3 Diagnose degradation

1. `GET /health` on core over mTLS.
2. If `queue.error` is `QUEUE_HEALTH_UNAVAILABLE`, the database read failed; check the primary and connection pool.
3. If `queue.oldestQueuedAgeMs` exceeds threshold, check `BackgroundJobWorker` progress, leases and handler failures.
4. If `queue.enabled` is false, the process would not have booted under the current guard; check whether the env changed after boot.
5. `/health` does not tell you about replica lag, Redis or audit/log health; query the storage engine from an operational shell or extend the health contract.

### 6.4 Rotate config

- Env is cached per process outside tests; restart the process after a change.
- Redis invalidation transport is configured once at startup; a Redis URL change requires a restart.
- Storage engine pools are created once; URL changes require a restart.
- Worker intervals and flags are read at startup.
- Deploy frontend flags require a rebuild or a runtime-config update, depending on which value is being changed.

## 7. Status and deviations

### Implemented

- Strict core env schema with PostgreSQL-only URL validation.
- Lazy/cached env proxy with a test fallback.
- TLS server, storage engine, platform runtime and workers composed in a defined order.
- Queue-drainability boot guard.
- Queue health in `/health`, including degraded state and safe error reporting.
- Redis-optional invalidation bus with local fallback.
- Request ID propagation and access-log sink.
- Raw body preservation for webhook/upload routes.
- Dedicated audit/log adapters selected by env.
- Deploy-owned admin UI flags.

### Partial

- **Schema-version enforcement.** Only seeders call `ensureSchemaVersion`; the server does not.
- **Logging.** `LOG_LEVEL` is unused; console ids differ from request ids; no structured JSON log contract; database query counts are always zero.
- **Worker controls.** `WORKER_CONCURRENCY` and `WORKER_REQUEST_TIMEOUT_MS` are parsed but not wired to the production worker runtime.
- **Health.** Only the background-job queue is checked; storage, replicas, Redis, audit/log and backup are not.
- **Env secrecy.** `envSummary` redacts `DATABASE_URL`, `LEADER_ELECTION_DATABASE_URL`, `KMS_MASTER_KEY` and `MTLS_SERVER_KEY_PATH`; replica/audit/log URLs and many certificate paths are not redacted by that helper.
- **Fake Rails CIDR.** `FAKE_RAILS_ALLOWED_CIDRS` is accepted but not consumed by the engine guard.

### Missing / deferred

- Prometheus/OpenTelemetry metrics and traces.
- Structured log levels and a request-scoped actor id in access logs.
- A startup migration/version gate.
- A disk spool for log backpressure; the buffer drops records instead.
- A runtime config reload endpoint; all settings are process-start values.
- A `/health` contract that covers storage and backup.

### Known bugs / risks

- **Code gap:** a stale schema can boot and fail later, because no boot-time schema check exists.
- **Code gap:** `LOG_LEVEL` is a no-op, so production cannot change console verbosity through config.
- **Code gap:** console log correlation uses a different id from the response/access log, which makes cross-referencing harder.
- **Code gap:** the `BackgroundJobWorker` starts before `listen`; a listen failure does not stop it in the rejection path.
- **Risk:** `TRUST_PROXY` defaults to false, but the access logger prefers `x-real-client-ip` regardless; only the edge/private boundary makes that safe.
- **Documentation gap:** historical designs describe a full metrics/alerting stack and hourly Redis snapshots; neither is part of the current runtime.

## 8. Verification and tests

- `core-back/test/db-connection-config.test.ts` validates PostgreSQL URL parsing, pool configuration and rejection of non-PostgreSQL URLs.
- `core-back/test/runtime/raw-body.test.ts` verifies raw-body path selection and body preservation.
- `core-back/test/runtime/production-adapters.test.ts` verifies the production ports and worker composition.
- `core-back/test/runtime/rotating-refresh-token.test.ts` verifies rotated refresh-token persistence.
- `core-back/test/worker-runtime-health.test.ts` verifies queue health thresholds and degradation.
- `core-back/test/storage-engine/engine-factory.test.ts` verifies storage health and adapter construction.
- `core-back/test/storage-engine/cache-velocity.test.ts` verifies Redis/memory cache and velocity behavior.
- `admin-back/test/env-isolation.test.ts`, `merchant-back/test/env-isolation.test.ts` and `checkout-back/test/env-isolation.test.ts` verify edge env isolation.
- `core-back/test/setup.ts` sets `LOG_LEVEL=error` for tests, although the logger does not consume it.

No test run was performed for this documentation change. PostgreSQL/Redis-backed suites require the corresponding services and are expected to skip or fail without them.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` §2.1 roles and boundaries, §9.1 durable timers/state rules.
- `design/90-archive/delivery-logs/opencode_technical_delivery_design.md` §28 PostgreSQL 18, storage engine, workers and horizontal scaling.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` §2 storage engine ports and §3 outbox/read models.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` §6 ordered pipeline and env delivery.
- `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md` §15 API/observability intent.

### Code paths

- `core-back/index.ts` for startup, health, TLS, Redis invalidation and signals.
- `core-back/lib/env/index.ts` for the full core schema.
- `core-back/lib/db/connectionConfig.ts` and `core-back/prisma/client/index.ts` for the DB client and schema version.
- `core-back/lib/storageEngine/index.ts` for adapter construction.
- `core-back/engine/workers/productionRuntime.ts` for worker composition and queue health.
- `core-back/lib/invalidationBus/index.ts` for local/Redis invalidation.
- `core-back/lib/requestLogger/index.ts` and `rawBody/index.ts` for logging and raw bodies.
- `admin-back/lib/env/index.ts`, `merchant-back/lib/env/index.ts`, `checkout-back/lib/env/index.ts`, `fake-rails-back/lib/env/index.ts`.
- `deploy/deploy.ts` and `deploy/lib/configSchema.ts` for deploy flags.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/stale-claims-register.md` (SC-013, SC-014)

## 10. Change history

- 2026-11-03: Initial canonical runtime/config part written against `5a24f6f+working-tree`; records schema-version, logging and worker-control gaps.

## 11. Security hardening config changes (2026-11-05)

- Core: `ALLOW_EMPTY_OUTBOUND_HOST_ALLOWLIST` (default false); the deploy engine sets `KYB_SCANNER_MODE` (default `eicar`, the built-in content gate; `disabled` leaves documents PENDING; `clamd` scans with ClamAV: with `KYB_CLAMD_ADDRESS` empty the deploy engine installs and configures clamd and freshclam on every core host (loopback `127.0.0.1:3310`), with an address it uses that daemon and installs nothing); `REQUIRED_SCHEMA_VERSION = 37`.
- Edges: `TRUSTED_PROXY_CIDRS` default loopback only; `MAX_INBOUND_BODY_BYTES` default 1 MiB; `CORS_ALLOWED_ORIGINS` (no CORS headers on admin/merchant when unset); newly wired rate-limit window envs `AUTH_/ADMIN_/API_/EXTERNAL_/PAY_/INBOUND_RATE_LIMIT_WINDOW_MS`; `CORE_MAX_RESPONSE_BYTES` (64 MiB), `CORE_TOTAL_DEADLINE_MS` (300000), `MAX_STREAMS_PER_IP` (5), `ADMIN_AUTHORITY_HINTS` (default empty, restrict-only), merchant `TOKEN_MAX_SCOPES`, `TOKEN_MAX_TTL_DAYS`, `TOKEN_DEFAULT_TTL_DAYS`, `UPLOAD_RATE_LIMIT_MAX`, admin `BACKUP_JOB_RATE_LIMIT_MAX` (6 per 10 minutes).
- Frontends: `VITE_CHECKOUT_BASE_URL`, `VITE_IDENTITY_HOSTS` (merchant), `VITE_CHECKOUT_ORIGIN` (fake-rails). Real `.env` files in the frontends are no longer tracked; copy `.env.example` to `.env` on a fresh clone.
- Deploy and daemon keys are listed in the deploy parts.

## Remediation round 2 (2026-11-08): new configuration keys

| Key | Where | Meaning |
| :--- | :--- | :--- |
| `UPLOAD_RATE_LIMIT_MAX` | admin-back | Uploads per address per rate-limit window (default 20). |
| `LEDGER_RAW_SQL` | core-back | `false` turns the raw-SQL ledger posting path off (default on). |
| `FAKE_RAILS_WEBHOOK_ALLOWED_HOSTS` | fake-rails-back | Extra hosts (`host` or `host:port`) a webhook may target; the host of `CORE_INBOUND_BASE_URL` is always allowed. |
| `PG_APP_USER`, `PG_APP_PASSWORD` | deploy | The non-owner role the deployed application connects as; setting the password enables the split (see `deploy.storage`). |
