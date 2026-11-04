---
id: platform.observability
title: Observability
status: partial
confidence: high
last_verified: 2026-11-04
verified_against: 5a24f6f+working-tree
code:
  - core-back/index.ts
  - core-back/lib/requestLogger/index.ts
  - core-back/lib/storageEngine/auditAndLogAdapters.ts
  - core-back/lib/storageEngine/outboxWorkers.ts
  - core-back/lib/storageEngine/ports.ts
  - core-back/lib/storageEngine/index.ts
  - core-back/engine/workers/productionRuntime.ts
  - core-back/api/internal/backups.ts
  - core-back/lib/storageEngine/backupControlClient.ts
  - core-back/engine/flow/DynamicRailEngine.ts
  - deploy/backup-daemon/src/server.ts
  - deploy/backup-daemon/src/backupEngine.ts
design_sources:
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#11-service-level-objectives-slos-incident-runbooks--dr-replay
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#11-service-level-objectives-slos-incident-runbooks--dr-replay
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#24-non-blocking-buffered-log-sink--dedicated-audit-shipper
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#5-segment-4--backup-management-orchestrator--admin-control-plane-pg-backup-daemon--core-back--admin-front
  - design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md#15-api-surface-and-observability
tests:
  - core-back/test/worker-runtime-health.test.ts
  - core-back/test/internal-routes.test.ts
  - core-back/test/backup-admin/backup-admin-routes.test.ts
  - core-back/test/backup-admin/backup-control-client.test.ts
  - core-back/test/storage-engine/log-sink.test.ts
  - core-back/test/storage-engine/audit-chain.test.ts
  - core-back/test/storage-engine/outbox-workers.test.ts
  - checkout-back/test/error-and-logger.test.ts
  - deploy/backup-daemon/test/server.test.ts
gaps:
  - No Prometheus/OpenTelemetry metrics or traces.
  - Storage health exists in code but is not exposed over HTTP.
  - No metrics endpoint for route, gateway, queue, replica or DB health.
  - No gateway_wire_logs table; only step and access logs.
  - No disk spool for log backpressure; buffers drop records.
  - Access logs record zero dbQueries/dbDurationMs and no actor id.
  - No outbox/audit retention policy in code.
  - LOG_LEVEL is not used by the logger.
---

# Observability

## 1. Purpose and scope

This part documents what the platform actually exposes and records for operations: the `/health` contract, queue health, request and access logging, step logs, the dedicated audit and log databases, the storage health method, backup observability, and the gaps against the historical SLO/metrics design.

It covers core and edge health endpoints and the backup daemon overview. It does not define on-call procedures, alert routing or dashboards that are not in the repository. The historical SLOs and runbooks are design intent, not current automated behavior.

## 2. Design intent (extracted and synthesized from ./design)

The historical design requires:

- Liveness/readiness distinction and a health endpoint that detects a stuck queue.
- Per-route metrics: initiate/confirm success rates, latency percentiles, OTP send failures, `UNKNOWN` count and age, webhook lag, polling load, breaker state, fee variance and settlement lag.
- Alerts for stale `UNKNOWN`, late success, conflicting signals, rejected callbacks from unlisted IPs, signature-failure spikes, unmapped response codes, reconciliation mismatch, token-refresh failures, credential-check failures, clearing drift and merchant receivable above ceiling.
- Dashboards for volume/success by gateway, rail and merchant; funnel by collection mode; operator queues.
- A dedicated audit database with an append-only SHA-256 hash chain and an integrity verifier.
- A dedicated operational log database with monthly-partitioned `attempt_step_logs`, `http_access_logs` and `gateway_wire_logs`, fed by a non-blocking bounded buffer every 250 ms.
- A backup control plane with WAL lag, target health, run catalog, drill reports and an admin overview.
- SLOs: attempt initiation availability 99.9%, OTP confirmation p95 < 4 s, webhook processing p95 < 30 s, 95% of `UNKNOWN` resolved within 24 h, reconciliation freshness 99% within 4 h, and zero ledger drift.

The code implements the health contract, the log/audit planes and the backup overview. It does not implement the metrics/alerts/dashboards or the `gateway_wire_logs` table.

## 3. As-built architecture

### 3.1 Core `/health`

The only core health route is `GET /health` on the TLS listener, registered before the routers. It is not exposed by an edge and is not a public endpoint.

It computes:

```text
thresholdMs = WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS
workersEnabled = WORKER_ENABLED && WORKER_BACKGROUND_JOBS_ENABLED
queue = readBackgroundJobQueueHealth(client, { now, thresholdMs })
degraded = !workersEnabled || !queueReachable || queue.degraded
```

`readBackgroundJobQueueHealth` issues two queries:

1. `count` of `background_jobs` where `state = 'QUEUED'`.
2. `findFirst` of the oldest `QUEUED` job, ordered by `createdAt` ascending, selecting `createdAt`.

It computes `oldestQueuedAgeMs` and marks `degraded` when that age exceeds the threshold. On a database exception the route catches the error, sets `queueReachable = false`, and returns a zeroed queue with `error: "QUEUE_HEALTH_UNAVAILABLE"`. It does not leak the exception text or tenant rows.

The response shape is:

```json
{
  "msg": "OK" | "DEGRADED",
  "status": "ok" | "degraded",
  "service": "core-back",
  "queue": {
    "enabled": true,
    "queued": 0,
    "oldestQueuedAgeMs": null,
    "thresholdMs": 300000,
    "degraded": false,
    "error": "QUEUE_HEALTH_UNAVAILABLE"
  }
}
```

The `error` key is present only when the queue is unreachable. HTTP status is always 200, so a load balancer cannot distinguish degraded from healthy by status code.

What it does **not** check:

- PostgreSQL primary/replica latency or lag.
- Redis reachability.
- Audit or log database reachability.
- Storage engine health (`engine.health()` exists but is not called by the route).
- Backup daemon health.
- Worker heartbeat or last successful tick.
- `RUNNING` jobs whose lease expired, or failed jobs.
- Outbox/audit shipper lag.
- External gateway health or circuit breakers.

### 3.2 Channel and edge health

Each internal router has a trivial health route:

| Route | Auth | Response |
| :--- | :--- | :--- |
| `GET /internal/admin/health` | mTLS channel only, before `requireAuthentication` | `{ status: "ok", channel: "admin" }` |
| `GET /internal/merchant/health` | mTLS channel only, before `requireAuthentication` | `{ status: "ok", channel: "merchant" }` |
| `GET /internal/checkout/health` | mTLS channel only | `{ status: "ok", channel: "checkout" }` |

Each edge has an unauthenticated `GET /health` returning `{ status: "ok", service, uptime }`. The edge health route does not check core reachability, certificate expiry or the route pool. A healthy edge can be serving 502s because core is down.

The backup daemon has `GET /health` returning its status, engine mode and version, and `GET /v1/overview` returning engine mode, WAL health, targets, schedule/policy, recent backups and drills.

### 3.3 Request logger and access log

`requestLoggerMiddleware` attaches a console logger to each request. The console format is a timestamped header with a six-character random id, method, path, status, duration, content length and client IP, followed by request-scoped info/warn/error lines. Status >= 500 or an error line goes to `console.error`; status >= 400 or a warning goes to `console.warn`; otherwise `console.log`.

On response finish, the middleware writes one access record to `LogSinkPort.writeAccessLog`:

```ts
{
  requestId: req.requestId,
  channel: "admin" | "merchant" | "checkout" | "webhook",
  method,
  routePattern: req.route?.path ?? req.path,
  statusCode,
  durationMs,
  dbQueries: 0,
  dbDurationMs: 0,
  actorId: null,
  clientIp: x-real-client-ip ?? req.ip,
  createdAt: new Date()
}
```

Important actual behavior:

- The console id is generated independently from `x-request-id`, so console lines and `http_access_logs` rows do not share a correlation id.
- `dbQueries` and `dbDurationMs` are hard-coded zeros; there is no query instrumentation.
- `actorId` is always null; the principal/user is not attached to the access record.
- `routePattern` uses Express `req.route.path`, which is the matched route pattern for the final handler, not necessarily the full internal namespace path.
- The channel is inferred from the path prefix, not from the certificate.
- The access-record write is best-effort; exceptions are swallowed.
- There is no sampling, rate limiting or body capture.
- `LOG_LEVEL` is not consulted, so console verbosity is fixed by the logger implementation and the console stream used.

### 3.4 Step logs

`DynamicRailEngine.recordStepLogs` sends each `StepExecutionResult.logs` entry to `LogSinkPort.writeStepLog` when a log sink is configured. The record contains:

- `attemptId`, `gatewayVersionId`, `phase`, `stepId`, `stepOrder`.
- `redactedRequestJson`, `redactedResponseText`.
- `httpStatus`, `durationMs`, `outcome`, `createdAt`.

Redaction happens before the sink call through `Vault.redactPayload` with the literal secrets. The engine catches sink exceptions so logging cannot fail a payment.

`StepExecutor` also calls its optional logger with redacted request/response data. In the production runtime the sink is the dedicated DB adapter; the executor logger is not configured with a separate transport in the current composition.

The log database adapter:

- Buffers step logs up to `STORAGE_LOG_BUFFER_MAX`.
- Flushes every `STORAGE_LOG_FLUSH_INTERVAL_MS` (default 250 ms) and immediately when the step buffer reaches 250 records.
- Inserts at most 500 step rows and 500 access rows per flush.
- Inserts into `attempt_step_logs` with `ON CONFLICT (id, created_at) DO NOTHING`.
- Inserts into `http_access_logs`.
- On a step insert failure, unshifts the batch back if the buffer has room; otherwise the batch is lost.
- Drops access records when the access buffer is full.
- Keeps an in-memory bounded map of step logs per attempt when there is no log DB, and for a short window when there is one.

There is no `gateway_wire_logs` table and no disk spool. The historical design's "gateway wire logs" and "spool to disk under pressure" are not implemented.

### 3.5 Audit database

When `AUDIT_DATABASE_URL` is set, core constructs a `DedicatedAuditDatabaseDriver`. Admin writes call `writeAudit`/`writeAuditLog`, which inserts into the transactional `audit_outbox` in the same transaction as the business change. The `AuditShipperWorker` then:

1. Claims a batch of `audit_outbox` rows where `shipped_at IS NULL`, ordered by `created_at` and `id`, using `FOR UPDATE SKIP LOCKED`.
2. Appends the batch to the audit database with an idempotent source id.
3. Updates `shipped_at = now()` for the batch.

The audit database stores an append-only SHA-256 chain: each row's `row_hash` covers the previous hash and the row identity/action/entity/before/after payload. `verifyHashChainIntegrity` recomputes from `seq_no` order and reports the first broken id. The schema and provisioner enforce append-only behavior (no update/delete) for the application role.

Important actual behavior:

- Shipped `audit_outbox` rows and processed `outbox_events` rows are pruned by the relay/shipper after `STORAGE_AUDIT_OUTBOX_RETENTION_MS` / `STORAGE_OUTBOX_RETENTION_MS` (default 1 h; 0 disables). Shipping uses a lease column (`audit_outbox.lease_until`).
- If the audit database is absent, `auditStore` is null and `AuditShipperWorker` is not started.
- Admin audit searches use the dedicated audit store when `AUDIT_DATABASE_URL` is configured; otherwise they read the primary `audit_log` table through Prisma.
- Audit logs are not a substitute for step logs; step logs are operational, audit logs are governance evidence.

### 3.6 Storage health method

`StorageEngine.health()` exists and returns:

- Primary: ok flag, latency, optional detail.
- Replicas: per-replica ok, healthy, lag ms and last replay LSN.
- Cache: ok, driver (`redis` or `memory`), optional detail.
- Audit: ok, configured.
- Logs: ok, configured.

It probes with bounded timeouts (2 s for DBs, 1 s for cache). The method is called by tests and is available to code, but there is **no HTTP route** that calls it. `/health` does not invoke it. An operator cannot inspect storage health through the public/channel API.

### 3.7 Backup observability

The core backup router is mounted at `/internal/admin/system/backups` after admin authentication:

| Route | Authority | Behavior |
| :--- | :--- | :--- |
| `GET /overview` | `security:read` or `gateway:read` | Calls daemon `/v1/overview` when configured; reads local `backup_catalog_runs` and `backup_restore_drills`; returns configured/reachable/error, engine mode, healthy, WAL, targets, schedule, policy, backups, latest drill, drills and local catalog |
| `POST /trigger` | `security:write` | Requires daemon; queues full/delta for `all`, `postgres_core`, `audit_db` or `redis`; writes a local `backup_catalog_runs` row |
| `POST /drill` | `security:write` | Requires daemon; queues a restore/invariant drill; writes a local `backup_restore_drills` row |
| `PUT /policy` | `security:write` | Without `approvalRequestId`, creates a `BACKUP_POLICY` approval; with an approved request, checks maker != checker and calls daemon `/v1/policy` |
| `GET /catalog` | `security:read` or `gateway:read` | Returns local runs/drills only |

The admin edge proxies `/overview`, `/trigger`, `/drill` and `/policy`; `/catalog` is not proxied by `admin-back`. When the daemon is not configured, the overview still returns the local catalog with `configured: false`, `daemonReachable: false` and `daemonError: "BACKUP_DAEMON_NOT_CONFIGURED"`; writes return 503.

The daemon's own overview includes:

- `engineMode` (`wal-g`, `barman`, or `none`).
- WAL archive lag, current LSN, last archived LSN, lag bytes.
- Targets with kind (`s3`, `ssh`, `redis`, `database`), health and detail.
- Schedule/policy.
- Backups and drills.

The daemon scheduler is UTC and supports full/delta/drill crons. It does not run an hourly Redis BGSAVE; Redis is a backup target when triggered.

### 3.8 What the admin audit/step views can show

- `GET /internal/admin/audit-logs` reads the configured audit store with filters, pagination, summary and export.
- `GET /internal/admin/audit-logs/:id` returns one audit row.
- Attempts expose step logs to the extent the admin routes call the log sink; the engine itself writes them to the sink.
- `GET /internal/admin/attempts/:id` returns attempt state and related data; the admin attempt detail view may call `queryStepLogsForAttempt`.

The access-log table is operational evidence, not a business audit. It records route/status/duration and a client IP but not the actor or request body.

## 4. Contracts and invariants

1. **Core health is private.** It is served only on the mTLS listener.
2. **Core health always responds 200.** Degradation is in the JSON, not the status code.
3. **Queue health reads only aggregate data.** It never returns tenant rows.
4. **A database failure in health does not crash the process.** It reports `QUEUE_HEALTH_UNAVAILABLE`.
5. **Logging never blocks a payment.** Engine and access-log writes are best-effort.
6. **Step logs are redacted before persistence.** The request/response payloads pass through the vault redactor.
7. **Audit outbox shipping is idempotent.** The audit database ignores duplicate source ids, and `shipped_at` is only set after append.
8. **Audit rows are retained.** `shipped_at` is a marker; there is no delete.
9. **Storage health is not an HTTP contract.** It is an internal method.
10. **Backup writes require the daemon.** The local catalog alone is not a control plane.

## 5. Data / API / config / deployment surface

### 5.1 Observability endpoints

| Surface | Method/path | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| Core | `GET /health` | mTLS client cert only | Queue health/degradation |
| Admin channel | `GET /internal/admin/health` | mTLS CN `admin-back` | Channel liveness |
| Merchant channel | `GET /internal/merchant/health` | mTLS CN `merchant-back` | Channel liveness |
| Checkout channel | `GET /internal/checkout/health` | mTLS CN `checkout-back` | Channel liveness |
| Admin edge | `GET /health` | None | Process liveness/uptime |
| Merchant edge | `GET /health` | None | Process liveness/uptime |
| Checkout edge | `GET /health` | None | Process liveness/uptime |
| Backup daemon | `GET /health` | mTLS (or insecure dev mode) | Daemon liveness/engine mode |
| Backup daemon | `GET /v1/overview` | mTLS | Full backup/PITR overview |
| Fake Rails | `GET /health`, `GET /hosted/health` | None/internal | Emulator liveness |

There is no `/metrics`, `/debug/vars`, `/ready` or `/version` route in core.

### 5.2 Log and audit stores

| Store | Driver | Tables | Enabled by |
| :--- | :--- | :--- | :--- |
| Core operational log DB | `DedicatedPostgresLogSink` | `attempt_step_logs`, `http_access_logs` | `LOG_DATABASE_URL` |
| Dedicated audit DB | `DedicatedAuditDatabaseDriver` | audit append-only table with `prev_hash`/`row_hash` | `AUDIT_DATABASE_URL` |
| Core transactional outbox | `outbox_events` | CQRS projector input | always (ledger/attempt writes) |
| Core transactional audit outbox | `audit_outbox` | shipper input | always for audited writes |
| In-memory step fallback | bounded map | per attempt | no log DB or read fallback |

### 5.3 Backup surface

| Core route | Admin edge route | Notes |
| :--- | :--- | :--- |
| `GET /internal/admin/system/backups/overview` | `GET /api/v1/admin/system/backups/overview` | Requires `security:read` or `gateway:read` |
| `POST .../trigger` | `POST /api/v1/admin/system/backups/trigger` | Requires `security:write`; relays 202 |
| `POST .../drill` | `POST /api/v1/admin/system/backups/drill` | Requires `security:write`; relays 202 |
| `PUT .../policy` | `PUT /api/v1/admin/system/backups/policy` | Requires `security:write`; maker-checker |
| `GET .../catalog` | not proxied | Local catalog only |

### 5.4 Relevant env keys

- `WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS` for health degradation.
- `LOG_DATABASE_URL`, `STORAGE_LOG_BUFFER_MAX`, `STORAGE_LOG_FLUSH_INTERVAL_MS` for logs.
- `AUDIT_DATABASE_URL` for the audit store.
- `BACKUP_DAEMON_URL`, `BACKUP_DAEMON_*` cert paths and timeout for backup.
- `LOG_LEVEL` (declared, unused).
- `PORT`, `HOST`, `MTLS_*` for the listener.

## 6. Operational usage

### 6.1 Check health over mTLS

```bash
curl --cert certs/admin-back-client.crt \
     --key certs/admin-back-client.key \
     --cacert certs/internal-ca.crt \
     https://127.0.0.1:4000/health
```

A healthy response has `status: "ok"` and `queue.degraded: false`. A degraded response has `status: "degraded"` with either `queue.enabled: false`, `queue.error: "QUEUE_HEALTH_UNAVAILABLE"`, or a too-old oldest queued job.

### 6.2 Inspect the queue

The health route only exposes the oldest queued age and count. For a deeper diagnosis, query `background_jobs` directly with the core database credentials:

```sql
SELECT state, count(*), min(created_at), max(created_at)
FROM background_jobs
GROUP BY state;
```

`RUNNING` jobs with an expired `locked_at` are re-queued by the worker; `/health` does not show them.

### 6.3 Inspect step and access logs

With `LOG_DATABASE_URL` set:

```sql
SELECT phase, step_id, http_status, outcome, duration_ms, created_at
FROM attempt_step_logs
WHERE attempt_id = $1
ORDER BY step_order, created_at;

SELECT request_id, channel, method, route_pattern, status_code, duration_ms, client_ip, created_at
FROM http_access_logs
ORDER BY created_at DESC
LIMIT 100;
```

The access table has no actor id and no query timing, so it answers "what route and status", not "who did it and how expensive was it".

### 6.4 Verify the audit chain

Use `DedicatedAuditDatabaseDriver.verifyHashChainIntegrity(limit)` from an operational script or test. It returns `{ verifiedCount, valid, firstBrokenId? }`. A broken chain should be treated as a P1 evidence incident.

### 6.5 Inspect backups

1. Ensure `BACKUP_DAEMON_URL` and the mTLS material are configured.
2. `GET /internal/admin/system/backups/overview` (or the admin edge route) for engine mode, WAL lag, targets, schedule/policy, backups and drills.
3. `POST /trigger` for a full/delta run, `POST /drill` for a restore/invariant drill.
4. `GET /catalog` for the local catalog when the daemon is unavailable.
5. Policy changes require a `BACKUP_POLICY` approval; the route refuses self-check.

### 6.6 What to monitor with an external system

Because there is no metrics endpoint, an external monitor can only poll:

- Core `/health` JSON over mTLS.
- Edge `/health`.
- Backup daemon `/health` and `/v1/overview`.
- PostgreSQL/Redis directly with their own exporters.
- The `background_jobs`, `outbox_events`, `audit_outbox` and `inbound_events` tables directly.

The historical alerts on gateway signature spikes, attempt latency, `UNKNOWN` age, clearing drift and credential-check failures are not emitted by the application.

## 7. Status and deviations

### Implemented

- Core queue health/degradation with a safe database-failure response.
- Channel and edge liveness endpoints.
- Console request logging with request-scoped messages.
- Access-log records to a dedicated log database.
- Redacted step logs with a dedicated log database and an in-memory fallback.
- Dedicated audit database with SHA-256 hash chaining and an integrity verifier.
- Transactional audit outbox with idempotent shipping.
- Storage health method with primary/replica/cache/audit/log probes.
- Backup overview, trigger, drill and policy control plane.
- Local backup catalog fallback.

### Partial

- **Access logs.** Zero query counts, no actor, separate console id, no sampling or retention.
- **Audit retention.** (Closed 2026-11-04) `audit_outbox` is pruned after the retention window; the dedicated audit database is the durable copy.
- **Storage health.** Implemented but not exposed over HTTP.
- **Backup health.** Core `/health` does not include the daemon; operators need the overview route.
- **Step log durability.** No disk spool; a full buffer drops records.
- **Log levels.** `LOG_LEVEL` is unused.
- **Metrics/alerts.** The SLO and alert catalog is design-only.

### Missing / deferred

- Prometheus/OpenTelemetry metrics and distributed tracing.
- `gateway_wire_logs`.
- A `/metrics` or `/ready` endpoint.
- A storage-health HTTP route.
- Per-route latency/error metrics, gateway success rates, `UNKNOWN` age metrics, webhook lag, polling load and circuit-breaker gauges.
- Disk-spooled log backpressure.
- Outbox/audit retention and partition maintenance automation.
- A worker heartbeat/last-tick metric.
- A backup daemon health proxy on core `/health`.

### Known bugs / risks

- **Code gap:** core `/health` stays HTTP 200 when degraded, which can mask a dead queue behind a naive load-balancer probe.
- **Code gap:** console log ids and `x-request-id` differ; cross-referencing requires the access table, not the console.
- **Code gap:** audit outbox rows and shipped audit rows have no retention; storage growth is unbounded in code.
- **Code gap:** log buffer overflow silently drops records; there is no counter for dropped logs.
- **Operational risk:** a healthy edge `/health` does not imply core reachability or certificate validity.
- **Documentation gap:** historical runbooks and SLO dashboards are not implemented as code or configuration.

## 8. Verification and tests

- `core-back/test/worker-runtime-health.test.ts` verifies queue health thresholds, worker-disabled degradation and the unreachable-queue path.
- `core-back/test/internal-routes.test.ts` verifies the internal channel health routes and route mounting.
- `core-back/test/backup-admin/backup-admin-routes.test.ts` verifies the backup overview/trigger/drill/policy contract.
- `core-back/test/backup-admin/backup-control-client.test.ts` verifies the daemon client, overview and health parsing.
- `core-back/test/storage-engine/log-sink.test.ts` verifies buffering, flushing, cap behavior and attempt queries.
- `core-back/test/storage-engine/audit-chain.test.ts` verifies hash-chain append and integrity checking.
- `core-back/test/storage-engine/outbox-workers.test.ts` verifies outbox/audit claim/ship behavior, including `shipped_at`.
- `checkout-back/test/error-and-logger.test.ts` verifies edge error/logger behavior.
- `deploy/backup-daemon/test/server.test.ts` verifies the daemon routes and health/overview responses.

No live monitoring stack, metrics scrape, restore drill or production-shaped log-volume test was run for this documentation change.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` §11 SLOs and runbooks.
- `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md` §11.1 SLOs, §11.2 runbooks.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` §2.4 log/audit adapters, §5 backup control plane.
- `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md` §15 API surface and observability.
- `design/90-archive/delivery-logs/opencode_technical_delivery_design.md` §28 backup endpoints and storage delivery.

### Code paths

- `core-back/index.ts` for `/health`.
- `core-back/lib/requestLogger/index.ts` for console/access logging.
- `core-back/lib/storageEngine/auditAndLogAdapters.ts` for audit/log drivers.
- `core-back/lib/storageEngine/outboxWorkers.ts` for shipping.
- `core-back/lib/storageEngine/index.ts` for storage health.
- `core-back/engine/workers/productionRuntime.ts` for queue health.
- `core-back/api/internal/backups.ts` and `core-back/lib/storageEngine/backupControlClient.ts` for backup observability.
- `deploy/backup-daemon/src/server.ts` and `backupEngine.ts` for the daemon surface.

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/stale-claims-register.md` (SC-013, SC-014)

## 10. Change history

- 2026-11-03: Initial canonical observability part written against `5a24f6f+working-tree`; records the actual health, queue, audit/log and backup observability and the missing metrics/tracing.
