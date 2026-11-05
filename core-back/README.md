# core-back — Core Engine Service

`core-back` is the only service in the platform that owns PostgreSQL 18, the database credentials, `KMS_MASTER_KEY`, the double-entry ledger, the durable workers and outbound gateway execution. It is a private service reachable only over mutual TLS 1.3 on the internal network.

## 1. Boundaries

- Owns `prisma/`, the generated Prisma client, `@prisma/adapter-pg`, the `pg` driver, `DATABASE_URL`, replica URLs, the optional audit/log database URLs, Redis and `KMS_MASTER_KEY`.
- Owns the dynamic rail engine, attempt state machine, ledger, governance, compliance, reconciliation, workers, storage engine and backup control client.
- Serves `/internal/admin`, `/internal/merchant` and `/internal/checkout`. Each namespace is bound to exactly one client-certificate common name: `admin-back`, `merchant-back` or `checkout-back`.
- Never listens publicly and is never published by a reverse proxy.
- Re-validates every request: bearer credential, user/merchant state, authority, payload, link/attempt state and monetary invariants. Edge checks are advisory.
- Does not own the edge portals, the deploy engine or the Fake Rails emulator. See [`../project-design/parts/01-core-back/00-foundations.md`](../project-design/parts/01-core-back/00-foundations.md) for the canonical boundary description.

## 2. Architecture

### 2.1 Process composition

`index.ts` exposes `createApp()`, `createHttpsServer()` and `start()`:

1. `assertBackgroundJobQueueDrainable()` refuses to boot when `WORKER_ENABLED` or `WORKER_BACKGROUND_JOBS_ENABLED` is false. Statement upload and dispute intake are queue-only routes; accepting work without a drain would strand it.
2. `configureRedisInvalidation()` connects a publisher and subscriber when `REDIS_URL` or the first `REDIS_NODES` entry is configured. A Redis failure logs a warning and leaves invalidation process-local.
3. `createHttpsServer()` builds the Express app, reads the server key, certificate and internal CA, and creates the TLS 1.3 listener with `requestCert: true` and `rejectUnauthorized: true`.
4. `getStorageEngine()` creates the process-wide storage engine: primary Prisma client, optional replica clients, read store, unit of work, cache/velocity adapter, audit driver and log sink.
5. `setPlatformStorage()` and `setAccessLogSink()` wire the engine into the domain runtime and request logger.
6. `createProductionWorkerRuntime()` starts the workers when `WORKER_ENABLED` is true.
7. The TLS server listens on `HOST:PORT`.
8. `SIGTERM` and `SIGINT` stop workers, clear sinks, close the invalidation transport, shut down the storage engine and close the server.

Tests import `createApp()` or `createHttpsServer()` instead of starting the full process. `NODE_ENV=test` bypasses the env cache so separate test files can use different configurations.

### 2.2 Express pipeline

The middleware order is fixed:

```text
x-powered-by disabled
trust proxy = TRUST_PROXY
requestIdMiddleware          (validates or generates x-request-id)
requestLoggerMiddleware      (console lines + best-effort access log)
rawBodyMiddleware            (opaque webhook/upload paths, 25 MiB)
express.json                 (1 MiB)
express.urlencoded           (1 MiB)
GET /health
/internal/<channel>          (channel certificate guard + router)
/api                         (publicRouter; limiter only, no routes)
terminal error handler
```

The error envelope is `{ code, message, reference?, details? }`. `ApiError` preserves its status, code and details; unexpected errors become `SERVER_ERROR` with a request reference. Malformed JSON returns HTTP 400 but currently still uses the generic `SERVER_ERROR` code.

The `/api` mount exists for the public router, which installs a 15-request/hour limiter but currently registers no endpoint.

Raw bodies are preserved before JSON parsing for:

- `/internal/checkout/inbound` and subpaths.
- `/internal/merchant/onboarding/kyb-documents`.
- `/internal/admin/reconciliation/upload`.
- `/internal/admin/join-requests/:id/kyb-documents`.

### 2.3 Channels, authentication and authorities

`requireEdgeIdentity(expectedCn)` runs before each internal router:

| Namespace | Accepted certificate CN |
| :--- | :--- |
| `/internal/admin/*` | `admin-back` |
| `/internal/merchant/*` | `merchant-back` |
| `/internal/checkout/*` | `checkout-back` |

A valid certificate on the wrong channel gets `403 FORBIDDEN_SERVICE_IDENTITY`; a missing or unauthorized certificate fails the TLS handshake and is defensively rejected with `401 MTLS_UNAUTHORIZED`.

- Admin routes require a bearer credential after the channel health and auth routes. Most business handlers call `requireAuthorities`, with `*` satisfying any requirement. The dashboard overview/export-audit, options and current-user academy progress routes require authentication only.
- Merchant routes require a bearer credential after the channel health and public auth routes. The principal must carry a `merchantId`; queries are scoped by it. Per-route authorities and API-token scopes are not enforced on individual merchant endpoints in the current tree.
- Checkout routes have no bearer authentication. The link key and attempt token are payer capabilities. Checkout never accepts a client-supplied amount or currency; the amount comes from `payment_links.amount`.
- `pg_live_` API tokens are SHA-256 hashed, checked for revocation and optional CIDR allowlisting. Session JWTs are HS256, issuer `payment-gateway-core`, a per-channel audience (`payment-gateway-admin`, `payment-gateway-merchant` or `payment-gateway-checkout`; the former shared `payment-gateway-edge` audience is rejected) and a unique `jti`, 12-hour lifetime. `POST /internal/{admin,merchant}/auth/logout` puts the `jti` on a revoke list (Redis when `REDIS_URL` is set, otherwise per-process memory). Authorities are re-read from the database on every session request.
- Maker-checker is enforced at the database constraint/trigger, the HTTP middleware and `executeApprovalSubject`. `SYSTEM_AUTOMATION` may draft but never check.
- MFA is a login-time challenge; the session JWT's `mfa` claim is not re-asserted per request. There is no per-session revocation table: disabling the user blocks the next request, and rotating `KMS_MASTER_KEY` invalidates sessions at the cost of making old vault ciphertext unreadable unless the old key id is retained. API-token revocation is immediate.

### 2.4 Health and observability

`GET /health` is available only on the mTLS listener. It reports:

```json
{
  "msg": "OK",
  "status": "ok",
  "service": "core-back",
  "queue": {
    "enabled": true,
    "queued": 0,
    "oldestQueuedAgeMs": null,
    "thresholdMs": 300000,
    "degraded": false
  }
}
```

It returns HTTP 200 for both healthy and degraded states. Degradation occurs when workers are disabled, the queue cannot be read (`QUEUE_HEALTH_UNAVAILABLE`) or the oldest `QUEUED` background job exceeds `WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS`. It does not probe replicas, Redis, audit/log databases, the backup daemon or external gateways.

Each internal channel also exposes `GET /internal/{admin,merchant,checkout}/health` after the channel guard. The storage engine has a richer `health()` snapshot for primary, replicas, cache, audit and logs, but it is not exposed over HTTP.

Request logging writes console lines with a separate short id and an `http_access_logs` record keyed by `x-request-id`. The access record carries route, status, duration, channel and client IP, with `dbQueries: 0`, `dbDurationMs: 0` and `actorId: null`. `LOG_LEVEL` is declared but not consulted by the current logger.

## 3. Database and storage

### 3.1 PostgreSQL 18 contract

- Engine: PostgreSQL 18. The Prisma datasource is `provider = "postgresql"`.
- Runtime driver: `@prisma/adapter-pg` (`PrismaPg`) over the `pg` driver.
- `DATABASE_URL`, `AUDIT_DATABASE_URL` and `LOG_DATABASE_URL` must be `postgresql://` or `postgres://` URLs; the environment validator rejects any other protocol. `DATABASE_REPLICA_URLS` is a comma-separated list consumed by the storage engine, and every entry must use the PostgreSQL protocol.
- IDs are native PostgreSQL `uuid` with UUIDv7 defaults. Money is `NUMERIC(18,4)` and application `Decimal`. JSON is `JSONB`; binary data is `BYTEA`.
- The complete model, column and index inventory is generated in [`../project-design/appendices/schema-catalog.md`](../project-design/appendices/schema-catalog.md). Do not hand-maintain schema counts here.
- The migration order and files are generated in [`../project-design/appendices/migration-catalog.md`](../project-design/appendices/migration-catalog.md).
- The committed history is forward-only: baseline schema, storage-engine indexes, CQRS read models and storage hardening. There are no down migrations. Recovery is restore/PITR or a new forward migration.
- `journal_lines` is monthly range-partitioned by `created_at`; the primary key includes `created_at`. The deploy engine installs a daily partition-maintenance cron. Elsewhere, run `SELECT ensure_journal_line_partitions(18)` on a schedule.
- Schema version 10 is required (latest migration `20261104120000_mfa_challenges`). `ensureSchemaVersion()` is called by the baseline seeder, the Fake Rails seeder and the synthetic seeder, but not by the HTTP start path. A stale database can boot and fail later at query time.

### 3.2 Storage engine ports

Every core process boots one `StorageEngine`:

| Port | Adapter | Responsibility |
| :--- | :--- | :--- |
| `UnitOfWork` / `StorageTx` | `PostgresUnitOfWorkAdapter` | One ACID transaction for domain writes, `outbox_events`, `audit_outbox`, sorted `gl_account_shards` locking and the post-commit WAL flush LSN. |
| `ReadStore` | `PostgresReplicaReadStore` | Primary/replica routing with `primary`, `replica` or `{ atLeastLsn }` consistency, lag monitoring and primary fallback. |
| `CacheStore` + `VelocityStore` | `RedisCacheAdapter` / `MemoryCacheAdapter` | L1/L2 cache and atomic Redis Lua sliding-window counters. Redis is never authoritative for money. |
| `AuditStore` | `DedicatedAuditDatabaseDriver` | Append-only SHA-256 hash chain in `pg_audit_db`, used by admin audit views and integrity verification. |
| `LogSink` | `DedicatedPostgresLogSink` | Bounded in-memory buffer flushing `attempt_step_logs` and `http_access_logs` to `pg_logs_db`; logging never blocks a payment. |

Supporting tables include `gl_account_shards` (16-way sharding for system GL accounts, one shard for merchant wallets), `outbox_events`, `audit_outbox`, `rm_merchant_daily_stats` and `rm_route_daily_volumes`. Worker claims use partial indexes; append-only time-series tables use BRIN and covering indexes; global search uses `pg_trgm` GIN indexes.

Actual behavior to keep in mind:

- The unit of work inserts buffered outbox and audit rows in the same transaction, then reports `pg_current_wal_flush_lsn()` as the commit watermark. A replica read can use that watermark.
- Outbox events are marked `processed_at`, never deleted. Only `attempt.transitioned` has a projection; `ledger.entry_posted` and the other declared topics are no-ops.
- Audit rows are marked `shipped_at`, never deleted. There is no application-level retention job for `outbox_events` or `audit_outbox`.
- Replica routing is used by global search and three merchant list endpoints. Most dashboards, lists and exports read the primary.
- Redis failures fall back to a process-local memory velocity store. The fallback does not coordinate across core nodes.
- The log sink drops the oldest step log at its buffer cap, can lose access logs on a failed flush, and never spools to disk. There is no `gateway_wire_logs` table.
- The read models are written but not read by current dashboards or list endpoints.

### 3.3 Workers

`createProductionWorkerRuntime()` starts:

| Worker | Default cadence | Purpose |
| :--- | :--- | :--- |
| `ExpirySweeperWorker` | `WORKER_POLL_INTERVAL_MS` | Inquires inquiry-capable attempts before expiring; excludes `AML_HOLD`; releases link slots on terminal failure/expiry/cancel. |
| `PollWorker` | `WORKER_POLL_INTERVAL_MS` | Reconciles inquiry schedules, applies route backoff and terminal transitions. |
| `InboundInboxWorker` | `WORKER_POLL_INTERVAL_MS` | Drains unprocessed inbound events; the live webhook route currently verifies synchronously, so this worker is effectively idle. |
| `OutboxNotificationWorker` | `WORKER_POLL_INTERVAL_MS` | Drains `notifications`, applies the AML tipping-off guard, redacts, renders, sends and retries with backoff. |
| `LedgerInvariantWorker` | Every 60 seconds | Verifies system-wide zero drift and opens one `MISMATCH`/`P1` operator case on drift. |
| `JoinRequestExpiryWorker` | `WORKER_POLL_INTERVAL_MS` | Expires abandoned drafts and overdue reviews. |
| `PeriodicScreeningWorker` | `WORKER_POLL_INTERVAL_MS` / `WORKER_RESCREEN_INTERVAL_MS` | Re-screens active merchants and owners; handles confirmed matches. |
| `KybExpiryWorker` | `WORKER_KYB_EXPIRY_INTERVAL_MS` | Marks expired documents, queues notices, suspends after grace and starts revalidations. |
| `RetentionWorker` | `WORKER_RETENTION_INTERVAL_MS` | Opt-in evidence purge; never removes journal entries or lines. |
| `BackgroundJobWorker` | `WORKER_BACKGROUND_JOBS_INTERVAL_MS` | Drains `RECONCILIATION_RUN` and `ADJUSTMENT_EXECUTION` with leases, retries and crash recovery. |
| `OutboxRelayWorker` | 250 ms | Projects `attempt.transitioned` into the two read models. |
| `AuditShipperWorker` | 500 ms | Ships `audit_outbox` to a dedicated audit database; only runs when `AUDIT_DATABASE_URL` is set. |

`WORKER_CONCURRENCY` and `WORKER_REQUEST_TIMEOUT_MS` are validated but not passed to the production runtime. `WORKER_ENABLED=false` and `WORKER_BACKGROUND_JOBS_ENABLED=false` are rejected at boot. Horizontal scaling relies on `FOR UPDATE SKIP LOCKED`, conditional updates and leases, not leader election.

## 4. Backup control

`lib/storageEngine/backupControlClient.ts` calls `pg-backup-daemon` over HTTPS mTLS when `BACKUP_DAEMON_URL` is configured. The internal admin routes are:

| Route | Authority | Behavior |
| :--- | :--- | :--- |
| `GET /internal/admin/system/backups/overview` | `security:read` or `gateway:read` | Merges the daemon overview with the local catalog and syncs daemon runs/drills into PostgreSQL. |
| `POST /internal/admin/system/backups/trigger` | `security:write` | Queues a full/delta run for `all`, `postgres_core`, `audit_db` or `redis`. |
| `POST /internal/admin/system/backups/drill` | `security:write` | Queues a restore/invariant drill. |
| `PUT /internal/admin/system/backups/policy` | `security:write` | Creates a `BACKUP_POLICY` approval; with an approved request it checks maker != checker and updates the daemon. |
| `GET /internal/admin/system/backups/catalog` | `security:read` or `gateway:read` | Returns only the local `backup_catalog_runs` and `backup_restore_drills`. |

`admin-back` proxies the first four under `/api/v1/admin/system/backups/*`; it does not proxy `/catalog`. When the daemon is not configured, writes return `503 BACKUP_DAEMON_NOT_CONFIGURED` while the overview still returns the local catalog with `configured: false` and `daemonReachable: false`.

The daemon wraps WAL-G or Barman and supports full/delta backups of the core database, the dedicated audit database and optional Redis snapshots. Restore drills verify double-entry zero drift, sharded balance parity and the audit hash chain. The in-process scheduler evaluates five-field cron expressions in UTC. Policy changes require maker-checker; trigger and drill are direct `security:write` actions.

Known deployment caveat: core reads `BACKUP_DAEMON_CA_CERT_PATH`, `BACKUP_DAEMON_CLIENT_CERT_PATH` and `BACKUP_DAEMON_CLIENT_KEY_PATH`, while the daemon reads `BACKUP_DAEMON_CERT_PATH`, `BACKUP_DAEMON_KEY_PATH` and `BACKUP_DAEMON_CA_CERT_PATH`. Verify the provisioned material in staging before relying on the control plane.

## 5. Runtime

### 5.1 Prerequisites

- Bun.
- PostgreSQL 18 on the configured host and port.
- OpenSSL for certificate generation.
- Optional Redis for cache, velocity and cross-node invalidation.
- Optional dedicated audit and log PostgreSQL databases.

### 5.2 Prepare the databases

The repository helper creates the application role, the application database, the test database and applies migrations to both:

```bash
POSTGRES_HOST=127.0.0.1 \
POSTGRES_PORT=55432 \
POSTGRES_ADMIN_USER=postgres \
./scripts/prepare-databases.sh
```

Defaults are role `gateway`, password `gateway`, database `payment_gateway_monolith` and test database `payment_gateway_monolith_test`. Override them with `POSTGRES_APP_USER`, `POSTGRES_APP_PASSWORD`, `POSTGRES_DATABASE` and `POSTGRES_TEST_DATABASE`. The script does not start PostgreSQL.

Manual equivalent:

```bash
createdb -h 127.0.0.1 -p 55432 payment_gateway_monolith
createdb -h 127.0.0.1 -p 55432 payment_gateway_monolith_test

export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith
export POSTGRES_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test
```

### 5.3 Start locally

```bash
cd core-back
bun install
bun run generate-mtls-certs

export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith
export KMS_MASTER_KEY="$(openssl rand -base64 32)"   # strong random value, at least 32 chars

bun run migrate-generate
bun run migrate-deploy
bun run db-seed
bun run start
```

The baseline seed creates administrator accounts but deliberately leaves their passwords unset. Activate one before signing in:

```bash
ADMIN_PASSWORD='<strong password>' bun run create-admin --email admin@example.com
```

`bun run start` listens on `HOST:PORT` (`127.0.0.1:4000` by default) with TLS 1.3 and requires a client certificate. `bun run dev` uses Bun watch mode.

Verify the listener:

```bash
curl --cert certs/admin-back-client.crt \
     --key certs/admin-back-client.key \
     --cacert certs/internal-ca.crt \
     https://127.0.0.1:4000/health
```

`db-seed` calls `ensureSchemaVersion()`, so migrations must be applied first. Starting the HTTP server does not perform that check.

### 5.4 Startup dependencies

| Dependency | Required | Failure behavior |
| :--- | :--- | :--- |
| mTLS server key/cert/CA | Yes | Startup throws with a message telling you to run `bun run generate-mtls-certs`. |
| `KMS_MASTER_KEY` | Yes | Invalid environment exits with code 1 and prints the failing key names. |
| PostgreSQL primary | Yes for real work | Boot succeeds until a query; `/health` reports the queue as unreachable. |
| Redis | No | Warning; memory cache/velocity and process-local invalidation. |
| `AUDIT_DATABASE_URL` | No | No dedicated audit store and no audit shipper. |
| `LOG_DATABASE_URL` | No | Step logs stay in memory; access logs are dropped. |
| Backup daemon | No | Backup writes return 503; local catalog remains readable. |
| Notification webhook | No | Log transport reports `SENT`, never `DELIVERED`. |
| Fake Rails | No | Required only for fake-rails seeding, synthetic history and emulator flows. |

## 6. Configuration reference

`lib/env/index.ts` defines a strict Zod schema. Only schema keys are read from `process.env`; unrelated variables are ignored. Booleans accept `true`/`1`/`yes` and `false`/`0`/`no`. Invalid non-test configuration prints the failing key names and exits with code 1. In `NODE_ENV=test`, the loader prints one warning and returns a local test fallback, which is why tests can load without real secrets but still need a reachable database for database-backed suites.

The authoritative whole-repository key inventory is [`../project-design/appendices/env-and-config-matrix.md`](../project-design/appendices/env-and-config-matrix.md). The tables below are the complete `core-back` surface and its defaults.

### 6.1 Process and network

| Key | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `4000` | TLS listener port. |
| `HOST` | `127.0.0.1` | TLS listener bind address. |
| `NODE_ENV` | `development` | `development`, `test` or `production`; controls test env caching and fallback. |
| `TRUST_PROXY` | `false` | Express `trust proxy`. |
| `LOG_LEVEL` | `info` | Validated but not consumed by the current logger. |

### 6.2 Database, storage and cache

| Key | Default | Purpose |
| :--- | :--- | :--- |
| `DATABASE_URL` | required | PostgreSQL primary URL. Must start with `postgresql://` or `postgres://`. |
| `DATABASE_REPLICA_URLS` | empty | Comma-separated PostgreSQL replica URLs for `ReadStore`. |
| `AUDIT_DATABASE_URL` | unset | Dedicated `pg_audit_db` URL for the append-only audit chain. |
| `LOG_DATABASE_URL` | unset | Dedicated `pg_logs_db` URL for buffered step/access logs. |
| `REDIS_URL` | unset | Redis URL for cache/velocity and invalidation. |
| `REDIS_NODES` | empty | Comma-separated Redis hosts; the first entry is used when `REDIS_URL` is absent. |
| `READ_REPLICA_MAX_LAG_MS` | `2000` | Maximum replica lag for ordinary `replica` reads. |
| `STORAGE_QUERY_TIMEOUT_MS` | `5000` | Storage query/transaction deadline. |
| `STORAGE_LOG_BUFFER_MAX` | `5000` (max `100000`) | Maximum buffered log records. |
| `STORAGE_LOG_FLUSH_INTERVAL_MS` | `250` (max `60000`) | Log flush interval. |
| `STORAGE_SHARD_COUNT` | `16` (max `16`) | GL account shard count; the migration constrains `shard_id` to `0..15`. |

### 6.3 mTLS, KMS and backup control

| Key | Default | Purpose |
| :--- | :--- | :--- |
| `MTLS_CA_CERT_PATH` | required | Internal CA used to verify client certificates. |
| `MTLS_SERVER_CERT_PATH` | required | Core server certificate. |
| `MTLS_SERVER_KEY_PATH` | required | Core server private key. |
| `KMS_MASTER_KEY` | required, min 16 characters | Root key for AES-256-GCM vault encryption and session/MFA key derivation. |
| `BACKUP_DAEMON_URL` | unset | Optional base URL of `pg-backup-daemon`; use HTTPS in a deployment. |
| `BACKUP_DAEMON_CA_CERT_PATH` | unset | CA for the daemon mTLS client. |
| `BACKUP_DAEMON_CLIENT_CERT_PATH` | unset | Client certificate for the daemon. |
| `BACKUP_DAEMON_CLIENT_KEY_PATH` | unset | Client key for the daemon. |
| `BACKUP_DAEMON_TIMEOUT_MS` | `15000` (max `120000`) | Backup control-plane request timeout. |

The Vault also recognizes `KMS_KEYS_JSON` for multiple key ids; it is read outside the strict env schema. Keep the active key and any old key ids available when rotating, or existing ciphertext becomes unreadable.

### 6.4 Workers

| Key | Default | Purpose |
| :--- | :--- | :--- |
| `WORKER_ENABLED` | `true` | Master worker switch. Boot refuses `false` because queue-only routes exist. |
| `WORKER_POLL_INTERVAL_MS` | `5000` | Base cadence for most workers. |
| `WORKER_BATCH_SIZE` | `50` (max `1000`) | Base claim batch. |
| `WORKER_CONCURRENCY` | `4` (max `100`) | Validated but not passed to the production runtime. |
| `WORKER_MAX_ATTEMPTS` | `3` | Inbox/job retry ceiling. |
| `WORKER_REQUEST_TIMEOUT_MS` | `15000` | Validated but not wired into the current production composition. |
| `WORKER_RESCREEN_INTERVAL_MS` | `86400000` | Periodic merchant re-screening interval. |
| `WORKER_KYB_EXPIRY_INTERVAL_MS` | `21600000` | KYB expiry/notice/suspension cadence. |
| `WORKER_KYB_EXPIRY_BATCH_SIZE` | `200` (max `10000`) | KYB expiry batch. |
| `WORKER_RETENTION_ENABLED` | `false` | Enables the evidence-retention worker. |
| `WORKER_RETENTION_INTERVAL_MS` | `3600000` | Retention cadence. |
| `WORKER_RETENTION_BATCH_SIZE` | `500` (max `10000`) | Retention batch. |
| `RETENTION_DRY_RUN` | `false` | Reports what retention would purge without deleting. |
| `WORKER_BACKGROUND_JOBS_ENABLED` | `true` | Durable job-queue worker. Boot refuses `false`. |
| `WORKER_BACKGROUND_JOBS_INTERVAL_MS` | `2000` | Queue drain cadence. |
| `WORKER_BACKGROUND_JOBS_BATCH_SIZE` | `10` (max `1000`) | Queue claim batch. |
| `WORKER_BACKGROUND_JOBS_LEASE_SECONDS` | `300` | Claimed-job lease; an expired `RUNNING` job is re-queued. |
| `WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS` | `300000` | `/health` degradation threshold. |

### 6.5 Notifications

| Key | Default | Purpose |
| :--- | :--- | :--- |
| `NOTIFICATION_WEBHOOK_URL` | unset | SMS/email aggregator endpoint. Without it the log transport reports `SENT`. |
| `NOTIFICATION_WEBHOOK_TIMEOUT_MS` | `5000` (max `120000`) | Delivery attempt timeout. |

### 6.6 Fake Rails and synthetic data

| Key | Default | Purpose |
| :--- | :--- | :--- |
| `FAKE_RAILS_ENABLED` | `false` | Enables Fake Rails-aware seeding/flows. |
| `FAKE_RAILS_ALLOW_IN_PRODUCTION` | `false` | Required when `NODE_ENV=production` and Fake Rails is enabled. |
| `ALLOW_EMPTY_OUTBOUND_HOST_ALLOWLIST` | `false` | Outbound URL compile fails closed (`HOST_ALLOWLIST_EMPTY`) on an empty `allowed_hosts` unless `true`. |
| `IS_TEST_SERVER` | `false` | Must be `true` for the synthetic seeder. |
| `FAKE_RAILS_PUBLIC_BASE_URL` | unset | Public emulator base URL used by seeders and gateway base URLs. |
| `ALLOW_FAKE_RAILS_HOSTS` | `false` | Relaxes the SSRF private-address guard for exact allowed hosts. |
| `FAKE_RAILS_ALLOWED_HOSTS` | empty | Exact hosts permitted by the scoped SSRF exception and seeders. |
| `FAKE_RAILS_SEEDER_TOKEN` | unset, min 16 | Shared seeder handshake/bulk-sync token. |
| `FAKE_RAILS_ALLOWED_CIDRS` | empty | Declared for source-CIDR policy; the engine SSRF guard does not consume it. |

Keys read outside the env proxy include `KMS_KEYS_JSON`, `KYB_SCANNER_MODE` (unset fails closed: every document stays `PENDING` and is not previewable; `eicar` is for development/tests only and is the only mode that yields `CLEAN`; active content is `INFECTED` in every mode; this is not a real malware engine) and the `SYNTHETIC_*` seeder controls. Deploy-injected admin UI flags are frontend/deploy settings, not core keys. Configuration is cached per process outside tests; restart after changing it.

## 7. Scripts and command reference

| Command | Action |
| :--- | :--- |
| `bun run start` | Start the TLS server and workers. |
| `bun run dev` | Start with Bun watch mode. |
| `bun test` | Run the core test suite. |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run lint` | `oxlint .`. |
| `bun run migrate` | `prisma migrate deploy`. |
| `bun run migrate-dev` | Create, patch and apply a development migration. |
| `bun run migrate-deploy` | Apply committed migrations. |
| `bun run migrate-reset` | Drop/recreate the database and apply all migrations. |
| `bun run migrate-generate` | Regenerate the Prisma client into `generated/prisma`. |
| `bun run prisma:format` | Format the Prisma schema. |
| `bun run prisma:validate` | Validate the Prisma datamodel. |
| `bun run db-seed` | Baseline platform settings, GL accounts, blueprints, credential sets, templates, reporting rules and guides. |
| `bun run generate-mtls-certs` | Generate the internal CA, core server certificate and three edge client certificates under `certs/`. |
| `bun run create-admin` | Activate or re-provision a seeded administrator. |
| `bun run create-dev-users` | Create or re-provision the development admin maker/checker and merchant superuser. |
| `bun run seed-fake-rails` | Point seeded gateways at the Fake Rails emulator and derive verification secrets. |
| `bun run seed-synthetic-history` | Run the optional multi-year synthetic history seeder. |
| `./scripts/prepare-databases.sh` | Create the application/test databases and apply migrations. |

### 7.1 Administrator bootstrap

```bash
ADMIN_PASSWORD='<strong password>' bun run create-admin --email admin@example.com
ADMIN_PASSWORD='<strong password>' bun run create-admin --email compliance@example.com --role COMPLIANCE
ADMIN_PASSWORD='<strong password>' bun run create-admin --email admin@example.com --no-mfa   # MFA is on by default
```

Environment equivalents: `ADMIN_EMAIL`, `ADMIN_PASSWORD` (the only way to supply the password: `--password` on the command line is rejected), `ADMIN_ROLE`, `ADMIN_MFA=false` (MFA is on by default; `--no-mfa` also disables it). The password policy is 12-128 characters with a lowercase letter, an uppercase letter and a digit. The command is idempotent; it sets `ACTIVE`, clears a stale MFA secret and rotates the password. Roles are `GATEWAY_ADMIN`, `SECURITY_ADMIN`, `FINANCE`, `COMPLIANCE`, `MLRO`, `OPERATOR` and `SUPPORT`. The baseline seed creates the seeded accounts with no password and `INVITED` status on purpose.

### 7.2 Development superusers

```bash
DEV_PASSWORD='DevPassword123!' bun run create-dev-users
DEV_USERS_ALLOW_PRODUCTION=true DEV_PASSWORD='DevPassword123!' bun run create-dev-users
```

Creates `dev-admin@payment-gateway.local` (`COMPLIANCE`, all authorities, maker), `dev-checker@payment-gateway.local` (`MLRO`, all authorities, checker) and `dev-merchant@payment-gateway.local` (`MERCHANT_ADMIN`, attached to `Development Test Merchant`). MFA is disabled. Production is refused unless `--allow-production` or `DEV_USERS_ALLOW_PRODUCTION=true` is supplied. Remove these accounts before a real production launch.

## 8. Migrations and seeding

### 8.1 Schema workflow

```bash
bun run migrate-dev       # development: create + patch + apply a migration
bun run migrate-deploy    # production: apply committed migrations
bun run migrate-generate  # after schema changes, before typecheck/start
bun run prisma:validate
```

`migrate-dev` wraps Prisma: it runs `prisma migrate dev --create-only --name init`, removes the generated `DROP TABLE "schema_versions"` statement, appends the schema-version table DDL and an upsert to the new version (currently 10), then runs `migrate deploy`. Review the patched SQL before committing a migration. The patch is string-based.

`migrate-reset` is destructive; it drops and recreates the database. There are no down migrations. A partial restore that stops before the storage-hardening migration leaves schema version 7; seeders refuse to run, while the HTTP server can still boot because it does not check the version.

The `journal_lines` parent and its monthly partitions are created by the hardening migration. Keep the deploy partition cron or run `SELECT ensure_journal_line_partitions(18)` on the primary. The default partition is a safety net, not a substitute for maintenance.

### 8.2 Baseline seed

`bun run db-seed` is idempotent by lookup for most rows and covers:

- Platform settings `OD-1` through `OD-11` plus join-request, onboarding and KYB settings.
- System GL accounts.
- Gateway/rail/route/flow blueprints and related definitions.
- Platform credential sets.
- Bilingual notification templates.
- CBL large-transaction and suspicious-activity reporting rules.
- Checkout support configuration and per-rail help guides.

The baseline seed does not activate administrators; use `create-admin`.

### 8.3 Fake Rails bridge

`bun run seed-fake-rails` rewrites gateway environment base URLs and allowed hosts to the emulator, updates widget definitions to the emulator SDK and derives inbound verification secrets from the shared seeder token. Do not run it in an environment that must call real gateways.

`FAKE_RAILS_PUBLIC_BASE_URL` and `FAKE_RAILS_SEEDER_TOKEN` must be set. Core can reach the emulator only when `ALLOW_FAKE_RAILS_HOSTS=true`, the host is in `FAKE_RAILS_ALLOWED_HOSTS`, and the same host is in the gateway version's `allowed_hosts`.

### 8.4 Synthetic history seeder

`bun run seed-synthetic-history` builds a deterministic multi-year operation history for a designated test server. Its five-layer safety gate requires:

1. `IS_TEST_SERVER=true`.
2. `FAKE_RAILS_ENABLED=true` and `FAKE_RAILS_PUBLIC_BASE_URL`.
3. `FAKE_RAILS_ALLOW_IN_PRODUCTION=true` when `NODE_ENV=production`.
4. A non-empty `FAKE_RAILS_ALLOWED_HOSTS` that covers every configured gateway host.
5. A live Fake Rails seeder handshake with `FAKE_RAILS_SEEDER_TOKEN`.

It also requires a completed baseline seed and Fake Rails bridge. Profiles are `COMPACT`, `STANDARD` and `STRESS` via `SYNTHETIC_SEED_PROFILE`; `SYNTHETIC_SEED_KEY` identifies a completed run and seeds the PRNG; `SYNTHETIC_YEARS_SPAN` overrides the profile span. A completed key is skipped. The bulk writer is not transactional, so an interrupted run can leave partial rows; recreate the database for a clean rebuild. The seeder refuses to proceed on a non-zero ledger audit or an unbalanced entry.

The safety gate does not inspect the database host. Never point `IS_TEST_SERVER=true` at production data.

## 9. Tests

```bash
cd core-back

bun run typecheck
bun test
bun test --parallel=1

# Focused examples
bun test test/engine/ledger.test.ts
bun test test/storage-engine
bun test test/storage-engine/performance
bun test test/backup-admin
bun test test/e2e/postgres-payment.test.ts
bun test test/exhaustive/01-schema
bun test test/exhaustive/06-concurrency
```

`bunfig.toml` preloads `test/setup.ts`, which sets `NODE_ENV=test`, a default test `DATABASE_URL`, a test `KMS_MASTER_KEY` and the local certificate paths. Database-backed suites probe the database at module load and become `describe.skip` when it is unreachable. Redis suites do the same for Redis. `test/e2e/postgres-payment.test.ts` uses `test.skipIf(!reachable)`. Storage suites register visible `test.skip(...)` placeholders so skipped files are apparent.

Without PostgreSQL 18 the schema, ledger, storage, backup-admin, postgres-payment and exhaustive database suites prove nothing. Without Redis the live Lua velocity suite is skipped. A green `bun test` can therefore contain skips. Use `--parallel=1` for the database suites because they share one test database and the double-entry invariant. See [`../tests/README.md`](../tests/README.md) for provisioning and the full suite matrix.

The master exhaustive runner is:

```bash
../scripts/run-exhaustive-suite.sh
../scripts/run-exhaustive-suite.sh --deploy
E2E_LIVE=1 ../scripts/run-exhaustive-suite.sh
```

It does not provision PostgreSQL, Redis, browsers or a live stack. The `E2E_LIVE=1` cross-service journeys need a deployed local stack and, for the link journey, `E2E_LINK_KEY`.

## 10. Benchmarks

The benchmark runner is separate from the correctness gate:

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test \
  ../scripts/run-benchmarks.sh

# Equivalent, direct
bun test test/storage-engine/performance

# Filter one family
BENCHMARK_FILTER=write-path ../scripts/run-benchmarks.sh
```

Optional Redis:

```bash
export STORAGE_TEST_REDIS_URL=redis://127.0.0.1:56379
export REDIS_URL=redis://127.0.0.1:56379
../scripts/run-benchmarks.sh
```

The runner requires `DATABASE_URL`, `POSTGRES_TEST_DATABASE_URL` or `STORAGE_TEST_DATABASE_URL` and exits with code 2 when none is set. It runs the performance directory, then the full `test/storage-engine` regression, then `test/backup-admin`. It prints p50/p95 values but does not store a baseline or compare runs.

The thresholds are generous regression ceilings for developer hardware, not capacity claims. They do not prove sustained TPS, production row counts, deep-search latency, live replica failover or restore throughput. Treat a run without PostgreSQL and Redis as partial and state the skips.

## 11. Troubleshooting

| Symptom | Likely cause | Action |
| :--- | :--- | :--- |
| `Unable to read mTLS server key/certificate/CA` | Certificates are missing or paths are wrong. | Run `bun run generate-mtls-certs`; verify `MTLS_*` paths. |
| `Invalid environment configuration: KEY` | Missing or malformed required key. | Fix the printed keys. `DATABASE_URL` and audit/log URLs must be PostgreSQL URLs. |
| Process exits when workers are disabled | Queue drainability guard. | Leave `WORKER_ENABLED` and `WORKER_BACKGROUND_JOBS_ENABLED` true; the API has queue-only routes. |
| `/health` says `QUEUE_HEALTH_UNAVAILABLE` | The primary database read failed. | Check PostgreSQL reachability, credentials and connection pool. |
| `/health` degraded with a large `oldestQueuedAgeMs` | Background jobs are not draining. | Inspect `background_jobs` by state, `available_at`, `locked_at`, `attempts` and `last_error`; check handler failures and leases. |
| Seeders fail with a schema-version error | Migrations are partial or stale. | Run `bun run migrate-deploy`; verify the hardening migration moved the database to version 8. |
| API starts but queries fail after a deploy | The server does not check schema version at boot. | Apply migrations before starting; do not rely on the HTTP start path. |
| Redis warning and process-local invalidation | Redis is unset or unreachable. | Set `REDIS_URL` or `REDIS_NODES`; restart. Cache/velocity falls back to memory by design. |
| Audit views or hash-chain verification unavailable | `AUDIT_DATABASE_URL` is unset. | Configure the dedicated audit database; without it the audit shipper does not start. |
| Access logs missing | `LOG_DATABASE_URL` is unset or the buffer dropped rows. | Configure the log database; check the buffer cap and flush interval. |
| Backup writes return `503 BACKUP_DAEMON_NOT_CONFIGURED` | `BACKUP_DAEMON_URL` is unset. | Configure the daemon URL and mTLS material; use `/overview` for the local catalog. |
| Fake Rails calls blocked by the SSRF guard | The three-part allowlist is incomplete. | Set `ALLOW_FAKE_RAILS_HOSTS=true`, add the exact host to `FAKE_RAILS_ALLOWED_HOSTS`, and add it to the gateway version's `allowed_hosts`. |
| Synthetic seeder refuses to run | Safety gate or missing baseline. | Check `IS_TEST_SERVER`, Fake Rails flags, allowed hosts, seeder token, baseline seed and Fake Rails bridge. |
| Tests skip instead of running | PostgreSQL or Redis is absent, or the probe ran before the URL was set. | Start the service, export the URL before `bun test`, and apply migrations. Report the skip. |
| Typecheck fails after a schema change | Generated Prisma client is stale. | Run `bun run migrate-generate`. |
| `EADDRINUSE` on start | Another process owns `HOST:PORT`. | Stop the other process or change `PORT`/`HOST`. |
| Benchmark exits with code 2 | No database URL is configured. | Export `DATABASE_URL`, `POSTGRES_TEST_DATABASE_URL` or `STORAGE_TEST_DATABASE_URL`. |

## 12. Design references

Canonical entrypoint and parts:

- [`../project-design/INDEX.md`](../project-design/INDEX.md) — canonical design index.

- [`../project-design/parts/01-core-back/00-foundations.md`](../project-design/parts/01-core-back/00-foundations.md) — process boundary, middleware, errors and TLS.
- [`../project-design/parts/01-core-back/01-api-surface.md`](../project-design/parts/01-core-back/01-api-surface.md) — admin, merchant, checkout and backup route groups.
- [`../project-design/parts/01-core-back/02-engine.md`](../project-design/parts/01-core-back/02-engine.md) — rail engine and attempt lifecycle.
- [`../project-design/parts/01-core-back/03-ledger.md`](../project-design/parts/01-core-back/03-ledger.md) — double-entry ledger and templates.
- [`../project-design/parts/01-core-back/04-governance-compliance.md`](../project-design/parts/01-core-back/04-governance-compliance.md) — maker-checker, KYB, AML and reporting.
- [`../project-design/parts/01-core-back/05-workers.md`](../project-design/parts/01-core-back/05-workers.md) — worker inventory, outboxes and leases.
- [`../project-design/parts/01-core-back/06-storage-engine.md`](../project-design/parts/01-core-back/06-storage-engine.md) — ports, UoW, replicas, cache, audit and logs.
- [`../project-design/parts/01-core-back/07-data-schema-and-migrations.md`](../project-design/parts/01-core-back/07-data-schema-and-migrations.md) — schema, migrations and seeders.
- [`../project-design/parts/01-core-back/08-search.md`](../project-design/parts/01-core-back/08-search.md) — global search.
- [`../project-design/parts/01-core-back/09-backup-control.md`](../project-design/parts/01-core-back/09-backup-control.md) — backup routes, daemon and drills.
- [`../project-design/parts/01-core-back/10-synthetic-seeder.md`](../project-design/parts/01-core-back/10-synthetic-seeder.md) — synthetic history.
- [`../project-design/parts/01-core-back/11-tests-and-benchmarks.md`](../project-design/parts/01-core-back/11-tests-and-benchmarks.md) — test and benchmark inventory.
- [`../project-design/parts/00-platform/02-security-and-mtls.md`](../project-design/parts/00-platform/02-security-and-mtls.md) — security controls and limitations.
- [`../project-design/parts/00-platform/03-runtime-and-config.md`](../project-design/parts/00-platform/03-runtime-and-config.md) — runtime, config and startup order.

Generated artifacts:

- [`blueprint.md`](blueprint.md) — generated core blueprint.
- [`../project-design/PROJECT_DESIGN.md`](../project-design/PROJECT_DESIGN.md) — consolidated design.
- [`../project-design/STATUS.md`](../project-design/STATUS.md) — implementation status.
- [`../project-design/appendices/schema-catalog.md`](../project-design/appendices/schema-catalog.md) — models, columns and indexes.
- [`../project-design/appendices/migration-catalog.md`](../project-design/appendices/migration-catalog.md) — migration order.
- [`../project-design/appendices/api-route-matrix.md`](../project-design/appendices/api-route-matrix.md) — route inventory.
- [`../project-design/appendices/env-and-config-matrix.md`](../project-design/appendices/env-and-config-matrix.md) — environment matrix.
- [`../project-design/appendices/test-inventory.md`](../project-design/appendices/test-inventory.md) — test file inventory.

Historical design material lives under [`../design/`](../design/). It is reference only; the canonical behavior is the parts plus the code.

## 13. Multi-node runtime additions

- `x-pg-served-by` reports the store that served a replica-aware read; `x-pg-min-lsn` echoes the requested watermark.
- Attempt transitions are republished on the Redis-backed `realtime:attempt` topic. Checkout SSE and merchant POS streams subscribe to it and keep their database poll as a fallback.
- The dedicated audit database computes `prev_hash`/`row_hash` in a BEFORE INSERT trigger under `pg_advisory_xact_lock(994001)`. `AuditShipperWorker` inserts without hashes and reads them from `RETURNING`.
- `verify_audit_chain()` is installed by the deploy audit-DB provisioner and is used by the two-machine backup/audit gates.

## Security notes (2026-11-05)

- MFA challenges live in `mfa_challenges`; `/internal/merchant/auth/verify-identity` is retired (`410 IDENTITY_VERIFICATION_RETIRED`). Login and MFA throttles are per-instance memory counters.
- Merchant authorities come from a closed catalogue (`lib/auth/merchantAuthorities.ts`); API tokens carry only `link:write`, `link:read`, `payment:read` and may only call `/external/*`.
- Cash-out creation requires an idempotency key; approval checks ledger balance under a shard lock. See `project-design/parts/01-core-back/` for details and `project-design/TRACKER.md` for open gaps.
