---
id: core.workers
title: Background Workers and Outboxes
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - deploy/provisioners/auditAndLogDbProvisioner.ts
  - core-back/engine/workers/workerRuntime.ts
  - core-back/engine/workers/productionRuntime.ts
  - core-back/engine/workers/ExpirySweeperWorker.ts
  - core-back/engine/workers/PollWorker.ts
  - core-back/engine/workers/InboundInboxWorker.ts
  - core-back/engine/workers/OutboxNotificationWorker.ts
  - core-back/engine/workers/LedgerInvariantWorker.ts
  - core-back/engine/workers/JoinRequestExpiryWorker.ts
  - core-back/engine/workers/PeriodicScreeningWorker.ts
  - core-back/engine/workers/KybExpiryWorker.ts
  - core-back/engine/workers/RetentionWorker.ts
  - core-back/engine/workers/BackgroundJobWorker.ts
  - core-back/engine/workers/BackgroundJobHandlers.ts
  - core-back/engine/workers/GatewayInquirySchedules.ts
  - core-back/lib/storageEngine/outboxWorkers.ts
  - core-back/lib/storageEngine/outbox.ts
  - core-back/lib/audit/writeAudit.ts
  - core-back/index.ts
design_sources:
  - design/90-archive/delivery-logs/opencode_technical_delivery_design.md#phase-4-onboarding-kyb-aml-program-disputes-reconciliation-workers-core-back
  - design/90-archive/delivery-logs/opencode_technical_delivery_design.md#105-governance-execution-screening-layers-and-observability
  - design/90-archive/delivery-logs/opencode_technical_delivery_design.md#12-fourth-hardening-pass-conformance-audit-findings-closed
  - design/90-archive/delivery-logs/opencode_technical_delivery_design.md#28-delivery-run-4-postgresql-18-storage-engine-backups-and-horizontal-scaling
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#91-the-nine-governing-state-machine-rules
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#32
  - design/10-fixes/_0001_operator_cases.md
tests:
  - deploy/test/testMatrix.test.ts
  - core-back/test/engine/guards-and-workers.test.ts
  - core-back/test/expiry-sweeper-aml.test.ts
  - core-back/test/gateway-inquiry-schedules.test.ts
  - core-back/test/retention-worker.test.ts
  - core-back/test/background-jobs.test.ts
  - core-back/test/worker-runtime-health.test.ts
  - core-back/test/notifications-and-gl-accounts.test.ts
  - core-back/test/screening-and-caps.test.ts
  - core-back/test/storage-engine/outbox-workers.test.ts
  - core-back/test/storage-engine/audit-chain.test.ts
  - core-back/test/storage-engine/write-path.integration.test.ts
  - core-back/test/exhaustive/06-concurrency/confirm-webhook-return-race.test.ts
gaps:
  - The trigger is installed by the deploy provisioner, not by a Prisma migration, so an externally managed audit database must run the provisioner DDL.
  - "The inbound webhook route verifies and processes synchronously; `InboundInboxWorker` is wired but has no producer, so it is effectively idle."
  - "Checkout and POS SSE streams poll the database every 2-3 seconds instead of subscribing to the transition bus."
  - "`RetentionWorker` is disabled by default, does not purge AML/KYB/reporting evidence, and does not purge the ledger by design."
  - "`OutboxRelayWorker` handles `attempt.transitioned`; `ledger.entry_posted` and the other declared topics are no-ops, so there is no ledger-driven CQRS."
  - "`AuditShipperWorker` marks `shipped_at` and never deletes shipped rows; `audit_outbox` and `outbox_events` have no retention."
  - "`PollWorker` releases a slot for `FAILED`/`CANCELLED` but not for `EXPIRED`/`BLOCKED`, unlike the expiry sweeper's terminal release path."
  - "`JoinRequestExpiryWorker` uses raw updates without audit rows or merchant notifications."
  - "Per-worker health and metrics are not exposed; `/health` reports only durable-queue depth/age."
  - "`WORKER_CONCURRENCY` exists in env validation but is not used by the worker runtime."
---

# Background Workers and Outboxes

## 1. Purpose and scope

This part owns the stateless background loops that drain durable work in `core-back`: attempt expiry and polling, inbound inbox processing, notification delivery, ledger invariant checks, onboarding expiry, periodic screening, KYB lifecycle, record retention, the durable background-job queue, the transactional outbox relay, and the audit shipper. It also documents the production worker composition and the startup/health contract.

It does not own the business logic that a worker invokes. The workers call the engine, repositories, screening service, notification transport, and ledger. The ledger and governance invariants are documented in their own parts.

## 2. Design intent (extracted and synthesized from ./design)

The design requires stateless worker processes that use PostgreSQL as the durable timer and queue:

- `payment_attempts.expires_at` and `next_check_at` are polled by stateless workers using `SELECT ... FOR UPDATE SKIP LOCKED`; an expiring attempt is asked (`inquire`) before it expires when the route supports inquiry.
- `inbound_events` is drained by an inbox worker so webhook processing is inbox-first and deduplicated; `notifications` is a transactional outbox drained by a sender.
- Terminal transitions are applied at most once with a conditional `UPDATE ... WHERE terminal_at IS NULL`, and the double-entry invariant is checked continuously.
- Statement reconciliation and dispute/adjustment execution use a durable queue with leases, backoff, and crash recovery.
- The retention worker removes evidence after the configured period without moving a balance; the transactional outbox maintains read models, and the audit outbox ships audit rows to a dedicated audit database with a hash chain.

The design also presents realtime fan-out as event-driven. The as-built behavior differs in several places: inbound handling is synchronous on the request path, checkout/POS SSE streams poll the database, and the ledger outbox does not project a read model.

## 3. As-built architecture

### 3.1 Worker base

`BaseWorker` (`core-back/engine/workers/workerRuntime.ts:40`) provides:

- a `start`/`stop` lifecycle with a single in-process timer chain;
- `setTimeout` scheduling with ±10% jitter (`jitter`), not `setInterval`;
- `unref()` on the timer so the timer does not keep the process alive;
- one `tick` at a time in a process: the next tick is scheduled only after the current tick resolves;
- error isolation: a failed tick is logged and the loop continues;
- `runOnce()` for tests and manual ticks.

The loop is not a distributed lock by itself. Cross-node safety comes from `FOR UPDATE SKIP LOCKED` claims plus conditional updates (or from leases for background jobs).

### 3.2 Production composition

`createProductionWorkerRuntime` (`core-back/engine/workers/productionRuntime.ts:207`) builds the workers and connects their ports:

- inquiry port -> `platform.engine.inquire`, so an expired or due attempt is asked before a terminal decision;
- inbound handler -> `platform.engine.verifyCallback`;
- notification sender -> `NotificationTransport` (webhook when `NOTIFICATION_WEBHOOK_URL` is set, otherwise the log transport);
- storage engine -> outbox relay and, only for a dedicated audit store, the audit shipper;
- background-job handlers -> reconciliation and adjustment/dispute execution.

`core-back/index.ts:259` starts the runtime when `WORKER_ENABLED` is true. `assertBackgroundJobQueueDrainable` refuses to boot if workers or background jobs are disabled, because statement upload and dispute intake answer `202` and would otherwise strand work (`productionRuntime.ts:121`). `WORKER_ENABLED` and `WORKER_BACKGROUND_JOBS_ENABLED` therefore default to true and cannot be safely disabled in the current API configuration.

### 3.3 Worker inventory

| Worker | Trigger and default cadence | Claim / concurrency | Behavior | Status |
| :--- | :--- | :--- | :--- | :--- |
| `ExpirySweeperWorker` | `expires_at <= now`, every `WORKER_POLL_INTERVAL_MS` (5 s) | `FOR UPDATE SKIP LOCKED`, batch `WORKER_BATCH_SIZE` (50) | Inquires inquiry-capable routes first; applies definitive outcome; expires otherwise; excludes `AML_HOLD`; releases slot on terminal failure/expiry/cancel. | Implemented |
| `PollWorker` | `next_check_at <= now`, every poll interval | `FOR UPDATE SKIP LOCKED`, batch | Reconciles inquiry schedules, applies route backoff `[5,15,30,60,120,300]` seconds with a 900 s default window, transitions terminal states once, updates schedule metadata. | Implemented |
| `InboundInboxWorker` | `processed_at IS NULL`, every poll interval | `FOR UPDATE SKIP LOCKED`, batch | Calls the engine callback verifier, retries `RETRYABLE` errors up to `maxAttempts` (production default 3; class default 5), opens an operator case on terminal failure. | Partial / idle |
| `OutboxNotificationWorker` | `status = QUEUED` and `next_attempt_at <= now`, every poll interval | `FOR UPDATE SKIP LOCKED`, batch | Finds template, treats missing/tipping-off templates as delivery failures, redacts AML payload, renders, sends; retries with exponential backoff up to 8 attempts. | Implemented |
| `LedgerInvariantWorker` | every 60 s | Single verifier pass | Verifies the system-wide invariant; logs drift and opens one open `MISMATCH`/`P1` operator case. | Implemented |
| `JoinRequestExpiryWorker` | every poll interval | Raw updates, batch on overdue reviews | Expires `DRAFT` older than 30 days; expires overdue `SUBMITTED`/`IN_REVIEW`/`INFO_REQUESTED` reviews; excludes `PENDING_CHECKER`. | Partial |
| `PeriodicScreeningWorker` | every poll interval; 24 h rescreen interval | `FOR UPDATE SKIP LOCKED` on due merchants, then merchant row lock | Refreshes watch-list versions, screens merchant and owners, applies owner statuses, raises one confirmed-match case and suspends the merchant. | Implemented (L2 only) |
| `KybExpiryWorker` | every 6 h (`WORKER_KYB_EXPIRY_INTERVAL_MS`), batch 200 | Query + per-merchant transaction | Marks expired documents, queues 30/7-day notices, suspends after grace, starts periodic revalidations, expires overdue revalidations. | Implemented |
| `RetentionWorker` | every hour when enabled; batch 500 | Bounded transactions per table | Purges notifications, inbound events, step logs, audit logs, detail logs, terminal attempts and dependents; never purges the ledger. | Partial / opt-in |
| `BackgroundJobWorker` | every 2 s when enabled, batch 10 | `FOR UPDATE SKIP LOCKED` claim + `RUNNING` lease | Drains `RECONCILIATION_RUN` and `ADJUSTMENT_EXECUTION` jobs, retries with backoff, recovers expired leases. | Implemented |
| `OutboxRelayWorker` | every 250 ms, batch >= 100 | `FOR UPDATE SKIP LOCKED` | Projects `attempt.transitioned` into `rm_merchant_daily_stats` and `rm_route_daily_volumes`; marks `processed_at`. Other declared topics are no-ops. | Partial |
| `AuditShipperWorker` | every 500 ms, batch >= 100 | Claim batch then append to dedicated audit DB | Appends to the audit hash chain, then marks `audit_outbox.shipped_at`; never deletes. | Partial / conditional |

### 3.4 Expiry sweeper

`ExpirySweeperWorker` (`core-back/engine/workers/ExpirySweeperWorker.ts`) selects attempts in `CREATED`, `INITIATING`, `AWAITING_CUSTOMER`, `AUTHORIZING`, or `VERIFYING` whose `expires_at` has passed and whose `substatus` is not `AML_HOLD`. It refreshes route inquiry support once per tick.

For each attempt:

- if the route supports inquiry and an inquiry port exists, it calls `inquire`; a definitive terminal outcome (`SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`) is applied with a conditional update; non-terminal outcomes update status/substatus and continue;
- an inquiry error moves the attempt to `UNKNOWN` with `nextCheckAt = now + 60 s`;
- otherwise it transitions to `EXPIRED` with a conditional `WHERE terminal_at IS NULL`, releases the link slot, and writes an audit row.

The production inquiry port calls `DynamicRailEngine.inquire`, which performs the VERIFY phase and posts the confirmation ledger when the inquiry returns a trusted success. The sweeper itself does not post a ledger entry.

### 3.5 Poll worker

`PollWorker` (`core-back/engine/workers/PollWorker.ts`) selects attempts with `next_check_at <= now` in the pollable statuses, including `UNKNOWN`. It first reconciles persisted inquiry schedules (`reconcileGatewayInquiries`). For each attempt:

- a route `stopOnStates` match clears `nextCheckAt` and completes the active schedule;
- a manual inquiry schedule owns its own window start; otherwise the attempt creation time is the reference;
- `computeBackoffDelaySeconds` returns the next step or `null` when the 900 s default window elapses; an elapsed window expires the schedule and clears `nextCheckAt`;
- the query calls `Platform.engine.inquire`; terminal states are applied with a conditional update; non-terminal states are stored with a new `nextCheckAt`;
- `FAILED` and `CANCELLED` release the link slot; `EXPIRED` and `BLOCKED` do not.

The schedule metadata (`GatewayInquirySchedule`) records source, status, window start, next run, attempts, last result/error, and completion/cancellation. The poll worker marks a schedule `RUNNING` before the inquiry and updates it to `COMPLETED`, `RETRYING`, `EXPIRED`, or leaves it for reconciliation.

### 3.6 Inbound inbox

`InboundInboxWorker` (`core-back/engine/workers/InboundInboxWorker.ts`) is a complete inbox drainer: it selects unprocessed events, calls the handler, marks processed/skipped/failed, retries only `RetryableInboundError`, and opens an `UNKNOWN` operator case on a terminal failure. It also exposes `persistInboundEvent` with a dedupe lookup and raw insert.

The actual checkout inbound route does **not** use the worker. `POST /internal/checkout/inbound/:gateway/:env/:pathToken` (`core-back/api/internal/checkout.ts:1477`) validates the channel, gateway, environment, and dedupe key, inserts the `inbound_events` row, correlates the attempt, calls `engine.verifyCallback` synchronously, and marks the event processed in the same request before returning the configured acknowledgement. The worker's handler is wired, but no producer enqueues unprocessed rows for it. This is the main design deviation for this part.

The synchronous route stores the raw body and a redacted header subset, not the full header set. It marks `verificationError = VERIFICATION_PENDING` initially and records the final verification result. The separate `persistInboundEvent` helper is not called by the route.

### 3.7 Notification outbox

`OutboxNotificationWorker` (`core-back/engine/workers/OutboxNotificationWorker.ts`) drains the `notifications` table, not `outbox_events`. For each queued row it:

1. finds the template by code/channel/language;
2. records a delivery failure when the template is missing;
3. calls `assertNoTippingOff` and records a delivery failure when a non-`INTERNAL` template references AML variables;
4. redacts AML-like payload keys for non-`INTERNAL` classes;
5. renders subject/body;
6. calls the sender;
7. writes `SENT` or `DELIVERED`, or re-queues with exponential backoff up to 8 attempts.

The production sender uses the webhook transport when `NOTIFICATION_WEBHOOK_URL` is configured and the log transport otherwise. The log transport reports `SENT`, never `DELIVERED`; `IN_APP` notifications are delivered by the notification row itself. The rendered body of an `INTERNAL` template is never written to the log.

### 3.8 Ledger invariant worker

`LedgerInvariantWorker` runs `InvariantVerifier` every 60 seconds. On non-zero drift it logs the left/right sides, calls the optional `onDrift`, and opens a single open `MISMATCH`/`P1` case with a four-hour SLA. It does not halt payouts itself; the operator case and the admin invariant panel are the control surface.

### 3.9 Onboarding expiry

`JoinRequestExpiryWorker` expires abandoned `DRAFT` rows older than 30 days and expires overdue reviews in `SUBMITTED`, `IN_REVIEW`, or `INFO_REQUESTED` whose `sla_due_at` has passed, explicitly excluding `PENDING_CHECKER`. It uses direct SQL updates and does not write an audit row or queue a notification. The batch is limited for overdue reviews, but the draft expiry is a single update.

### 3.10 Periodic screening and KYB

`PeriodicScreeningWorker` (`core-back/engine/workers/PeriodicScreeningWorker.ts`) selects active merchants whose latest merchant screening is older than the rescreen interval using `FOR UPDATE SKIP LOCKED`, re-checks the due condition under the merchant row lock, screens the merchant and active owners with trigger `PERIODIC`, applies owner statuses, and handles only a `CONFIRMED_MATCH`: it raises one case (prefix `SCREENING_CONFIRMED_MATCH`) and suspends an active merchant with `AML_CONFIRMED_MATCH`. A potential match does not suspend or open a case here; it remains for the screening queue.

`KybExpiryWorker` (`core-back/engine/workers/KybExpiryWorker.ts`) performs five bounded passes:

1. mark accepted/uploaded documents whose `expires_on` passed as `EXPIRED`;
2. queue 30-day and 7-day `KYB_DOC_EXPIRING` notices using unique event keys;
3. suspend an active merchant whose required document is past the grace period with no replacement, setting `KYB_EXPIRED` and queuing `KYB_EXPIRED_SUSPENSION`;
4. start periodic revalidation requests for due merchants and advance `nextKybReviewAt`;
5. expire overdue revalidation requests.

### 3.11 Retention

`RetentionWorker` (`core-back/engine/workers/RetentionWorker.ts`) is disabled by default (`WORKER_RETENTION_ENABLED=false`) because it removes evidence. It resolves the period from an explicit option, then platform setting `OD-4`, then a five-year default. It supports a dry run.

It purges, in dependency order and bounded transactions:

- `notifications` older than the cutoff;
- `inbound_events` received before the cutoff;
- `attempt_step_logs` older than the cutoff and belonging to an attempt older than the cutoff;
- `audit_log` and `detail_change_logs` older than the cutoff;
- terminal attempts older than the cutoff whose journal entry is retained, together with their adjustments, disputes, operator cases, inbound events, step logs, and free attempt groups.

It deliberately never purges `journal_entries` or `journal_lines`, because deleting a line without folding it into a checkpoint would silently change a merchant balance while the system-wide invariant still balanced. AML cases, screenings, KYB documents, KYB revalidations, regulatory reports, platform settings, background jobs, `outbox_events`, and `audit_outbox` are not in the retention scope.

### 3.12 Background job queue

`BackgroundJobWorker` (`core-back/engine/workers/BackgroundJobWorker.ts`) is the durable queue for statement reconciliation and dispute/adjustment execution:

- `claimDueJobs` selects `QUEUED` jobs whose `available_at <= now`, marks them `RUNNING` and sets `locked_at` inside one transaction; the row locks are held until the mark commits;
- `recoverExpiredLeases` re-queues `RUNNING` rows whose `locked_at` is older than the lease (default 300 s);
- a missing handler or thrown error increments attempts and re-queues with exponential backoff (30 s base, 30 min cap) until `maxAttempts` (default 5), then marks `FAILED`;
- success marks `SUCCEEDED`, `completed_at`, clears `locked_at`, and logs the job id/type/reference.

Handlers (`core-back/engine/workers/BackgroundJobHandlers.ts`):

- `RECONCILIATION_RUN` parses the uploaded statement, matches items, posts settlement sweeps for batch sources, and posts fee variance true-ups.
- `ADJUSTMENT_EXECUTION` handles `kind: DISPUTE_INTAKE` through `openDisputeWithDraftedAdjustment`, and `kind: ADJUSTMENT_EXECUTION` through `executeApprovalSubject` using the approval id and recorded checker.

The job payload never carries an independent checker; the executed adjustment uses the checker recorded on the approval request.

### 3.13 Outbox relay and audit shipper

`OutboxRelayWorker` (`core-back/lib/storageEngine/outboxWorkers.ts:134`) claims unprocessed `outbox_events` with `FOR UPDATE SKIP LOCKED` and marks `processed_at` after the handler. Default handlers:

| Topic | Handler |
| :--- | :--- |
| `attempt.transitioned` | Projects `rm_merchant_daily_stats` and `rm_route_daily_volumes` using the event kind (`created` vs terminal), status, merchant, route, currency, gross, and net. |
| `ledger.entry_posted` | No-op. No ledger-driven read model is projected. |
| `merchant.updated` | No-op. |
| `kyb.document_uploaded` | No-op. |
| `reconciliation.completed` | No-op. |
| `config.invalidated` | No-op. |

The relay is instantiated only when a storage engine is supplied. Outbox rows are marked processed, never deleted; there is no outbox retention job.

`AuditShipperWorker` is instantiated only when `options.storage.auditStore` is a `DedicatedAuditDatabaseDriver`. It claims unshipped `audit_outbox` rows, appends them to the dedicated audit database's SHA-256 hash chain, and marks `shipped_at`. It is idempotent on the source id. Shipped rows are retained, not deleted. `writeAudit` only writes `audit_outbox` when `AUDIT_DATABASE_URL` is configured; otherwise `audit_log` is the only sink.

### 3.14 Realtime fan-out reality

The engine publishes attempt transition events on the invalidation bus, and the AML resolution path also publishes. The checkout status SSE (`core-back/api/internal/checkout.ts:1292`) and merchant POS SSE (`core-back/api/internal/merchant.ts:2392`) do **not** subscribe to that bus. They poll `payment_attempts` every 2 seconds (checkout, 10-minute deadline) or every 3 seconds (POS, 15-minute deadline) and write `event: status` / `event: attempts` frames. This is polling SSE, not a transition subscription.

### 3.15 Startup and health

`GET /health` (`core-back/index.ts:76`) reports `OK`/`DEGRADED` and a `queue` object with:

- whether workers and background jobs are enabled;
- queued job count;
- oldest queued job age;
- threshold (`WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS`, default 300 s);
- degraded flag.

It degrades when workers are disabled, the queue cannot be read, or the oldest queued job exceeds the threshold. It does not report per-worker liveness, tick age, notification backlog, inbound backlog, outbox lag, or audit-chain status. `readBackgroundJobQueueHealth` only reads `background_jobs`.

## 4. Contracts and invariants

1. A worker tick must not overlap with itself in the same process. Multiple nodes are allowed; claims use `FOR UPDATE SKIP LOCKED`.
2. Terminal attempt transitions are conditional on `terminal_at IS NULL`, so the same attempt is not expired, failed, or cancelled twice.
3. An `AML_HOLD` attempt is excluded from expiry sweeping, and the sweeper has a defense-in-depth check on `substatus`.
4. An expiring inquiry-capable attempt is asked before it is expired. An inquiry failure keeps it open (`UNKNOWN`/deferred) rather than silently expiring it.
5. A background job is executed at most once per claim, but handlers must be idempotent because a lease can expire and re-queue a job after a crash.
6. A notification delivery failure re-queues with backoff up to the attempt cap; a missing or tipping-off template is retried up to that cap and then marked `FAILED`.
7. The invariant worker opens at most one open `MISMATCH`/`P1` case for drift.
8. Retention never deletes ledger entries or lines and never deletes a terminal attempt whose ledger entry is missing; it stops rather than risk orphaning evidence.
9. Statement upload and dispute intake are queue-only; the service refuses to start if no background-job drain is enabled.
10. The notification worker never sends an AML variable to a non-`INTERNAL` template.
11. Outbox processing marks `processed_at`; the audit shipper marks `shipped_at`. Neither deletes rows.
12. SSE stream contract: checkout status ends on a terminal status or a 10-minute deadline; POS stream ends on a 15-minute deadline; both poll the database.

## 5. Data / API / config / deployment surface

### Tables and models

- Attempts and inbound: `payment_attempts` (`expires_at`, `grace_expires_at`, `next_check_at`, `terminal_at`, `substatus`) and `inbound_events` (body, redacted headers, dedupe key, verification, processed time/result).
- Queues and delivery: `notifications` (template, channel, language, payload, status, attempts, next attempt), `background_jobs` (type, reference, payload, state, attempts, availability, lease, error, completion), `outbox_events`, and `audit_outbox`.
- Lifecycle: `join_requests` (SLA fields), `merchants` (status, review date, suspension reason), `kyb_documents`, `kyb_revalidation_requests`, `aml_screenings`, `aml_cases`, `gateway_inquiry_schedules`.
- Read models: `rm_merchant_daily_stats`, `rm_route_daily_volumes`.

### Environment keys

| Key | Default | Purpose |
| :--- | :--- | :--- |
| `WORKER_ENABLED` | `true` | Starts the runtime; false is rejected at boot because queue-only routes exist. |
| `WORKER_POLL_INTERVAL_MS`, `WORKER_BATCH_SIZE` | 5000, 50 | Base cadence and batch for most workers. |
| `WORKER_CONCURRENCY`, `WORKER_MAX_ATTEMPTS` | 4, 3 | Concurrency is validated but unused; max attempts is passed to the inbound worker. |
| `WORKER_RESCREEN_INTERVAL_MS` | 86,400,000 | Periodic screening interval. |
| `WORKER_KYB_EXPIRY_INTERVAL_MS`, `WORKER_KYB_EXPIRY_BATCH_SIZE` | 21,600,000, 200 | KYB cadence and batch. |
| `WORKER_RETENTION_ENABLED`, `WORKER_RETENTION_INTERVAL_MS`, `WORKER_RETENTION_BATCH_SIZE` | `false`, 3,600,000, 500 | Retention enablement, cadence, batch. |
| `RETENTION_DRY_RUN` | `false` | Counts without deleting. |
| `WORKER_BACKGROUND_JOBS_ENABLED`, `WORKER_BACKGROUND_JOBS_INTERVAL_MS`, `WORKER_BACKGROUND_JOBS_BATCH_SIZE` | `true`, 2000, 10 | Durable queue enablement, cadence, batch. |
| `WORKER_BACKGROUND_JOBS_LEASE_SECONDS`, `WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS` | 300, 300000 | Crash-recovery lease and health degradation threshold. |

### Routes and surfaces

`GET /health` reports queue health only; `POST /internal/checkout/inbound/:gateway/:env/:pathToken` is the synchronous inbound path; admin gateway-inquiry routes schedule/cancel/run-now/retry persisted inquiry schedules. There is no worker-control or per-worker metrics endpoint.

## 6. Operational usage

### Starting and stopping

`core-back` is a single process that starts the HTTP(S) server and the worker runtime. `SIGTERM`/`SIGINT` stops the workers, clears storage/log sinks, closes Redis, shuts down the storage engine, and closes the server. There is no separate worker-only entrypoint in this repository.

### Observing

1. Check `GET /health` for queue depth, oldest queued age, and degraded state; for a stuck queue inspect `background_jobs` by `state`, `available_at`, `locked_at`, `attempts`, and `last_error`.
2. For expiry/poll issues inspect `payment_attempts.expires_at`, `next_check_at`, `terminal_at`, `substatus`, and `gateway_inquiry_schedules`; for notifications inspect `notifications.status`, `attempts`, `next_attempt_at`, and the template class.
3. For outbox/read-model lag inspect `outbox_events.processed_at`, `audit_outbox.shipped_at`, and the `rm_*` tables; for retention run with `RETENTION_DRY_RUN=true` first.

### Tuning

- Increase `WORKER_BATCH_SIZE` for throughput; the base worker still runs one tick at a time per process.
- Increase `WORKER_BACKGROUND_JOBS_BATCH_SIZE` carefully because each job may parse a statement or execute a refund, and increase the lease only when a legitimate handler can exceed it.
- Keep `WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS` below the operational SLA; do not rely on `WORKER_CONCURRENCY`, which has no runtime effect.

### Adding a worker

1. Extend `BaseWorker`, implement `tick`, and use a claim query with `FOR UPDATE SKIP LOCKED` or a conditional update; make every state change idempotent.
2. Add the worker to `createProductionWorkerRuntime`; gate evidence-destroying work behind an explicit env flag and a dry run.
3. Add a fake-DB test and a live PostgreSQL test where locking matters, and document its health/backlog surface.

## 7. Status and deviations

### Implemented

- Expiry sweeper with inquiry-first behavior, AML-hold exclusion, and conditional terminal updates; poll worker with route backoff, inquiry schedules, and terminal handling.
- Notification outbox with template lookup, tipping-off guard, redaction, rendering, backoff, and delivery states; ledger invariant worker and P1 operator case.
- Periodic screening (L2), KYB lifecycle, durable background-job queue with claim/lease/retry/handlers, outbox relay for attempt transitions, and audit shipper for a dedicated audit database.
- Startup guard for queue-only routes and queue health payload.

### Partial

- **Inbound inbox** — the worker is implemented and wired, but the checkout route processes synchronously and marks the event processed; the worker has no producer. The inbox-first asynchronous design is not in force.
- **Retention** — opt-in, dry-run capable, bounded, and ledger-safe, but the scope excludes AML/KYB/reporting evidence and the default is off.
- **Join-request expiry** — expires drafts/reviews but writes no audit row and sends no merchant notification.
- **Outbox relay / audit shipper** — only `attempt.transitioned` has a projection (`ledger.entry_posted` and four other topics are no-ops); the audit shipper only runs with a dedicated audit DB and never deletes shipped rows.
- **Realtime fan-out** — transition events are published, but checkout/POS clients receive polling SSE, not subscriptions.

### Missing / deferred

- Asynchronous webhook inbox processing on the request path.
- Transition-bus-backed SSE/WebSocket fan-out.
- Outbox and audit-outbox retention.
- Per-worker health, tick latency, backlog, and last-success metrics; separate worker deployment/entrypoint and real `WORKER_CONCURRENCY`.
- AML/KYB/report retention passes and batch/deferred AML monitoring worker.

### Known bugs / risks

- **Code gap:** `PollWorker` releases a link slot for `FAILED` and `CANCELLED` but not for `EXPIRED` or `BLOCKED`, unlike the expiry sweeper's terminal release path. A poll-discovered expiry can leave a slot reserved.
- **Code gap:** the synchronous inbound route marks the event processed even when verification fails; the event is not retried by the inbox worker. Verification failure is recorded but there is no asynchronous replay.
- **Code gap:** `InboundInboxWorker` retries `RetryableInboundError` on the next tick with no delay, so a persistent retryable failure can burn its attempt cap quickly.
- **Code gap:** merchant fallback balance reads can double count a checkpoint; this is documented in `core.ledger` but affects worker-written ledger balances too.
- **Risk:** retention and audit shipping are independent: retention purges `audit_log` and `detail_change_logs` on its own schedule without consulting `audit_outbox.shipped_at`, and the outbox rows are never purged.
- **Risk:** `OutboxRelayWorker` marks an unknown topic processed without a handler, so a newly added event type can be silently dropped until a handler is deployed.
- **Documentation gap:** the design describes an event-driven realtime and inbox-first system; the as-built system is synchronous on inbound and polling on SSE.

## 8. Verification and tests

Run:

```bash
cd core-back && bun test test/expiry-sweeper-aml.test.ts
cd core-back && bun test test/gateway-inquiry-schedules.test.ts
cd core-back && bun test test/retention-worker.test.ts
cd core-back && bun test test/background-jobs.test.ts
cd core-back && bun test test/worker-runtime-health.test.ts
cd core-back && bun test test/notifications-and-gl-accounts.test.ts
cd core-back && bun test test/screening-and-caps.test.ts
cd core-back && bun test test/storage-engine/outbox-workers.test.ts
cd core-back && bun test test/storage-engine/audit-chain.test.ts
cd core-back && bun test test/storage-engine/write-path.integration.test.ts
```

Coverage:

- `expiry-sweeper-aml.test.ts` / `gateway-inquiry-schedules.test.ts` — AML-held exclusion, normal expiry slot release, schedule running/complete/expire helpers.
- `retention-worker.test.ts` — cutoff boundaries, terminal attempt purge while retaining the journal, invariant preservation, dry run, platform-setting period, bounded batches, runtime registration.
- `background-jobs.test.ts` / `worker-runtime-health.test.ts` — single claim, second-node skip, backoff/failure, lease recovery, reconciliation, dispute intake, adjustment idempotency, no invented checker, startup guard, queue health.
- `notifications-and-gl-accounts.test.ts` / `screening-and-caps.test.ts` — transport selection, tipping-off rejection, delivery states, L2 screening, watch-list invalidation.
- `storage-engine/{outbox-workers,audit-chain,write-path.integration}.test.ts` and `exhaustive/06-concurrency/confirm-webhook-return-race.test.ts` — relay/projection, audit hash chain, atomic writes, confirmation races.

Database-backed suites require PostgreSQL 18; Redis-backed invalidation tests require Redis. Report skipped suites explicitly.

## 9. Source references

### Old design sections

- `design/90-archive/delivery-logs/opencode_technical_delivery_design.md` Phase 4 worker task; §10.5 governance/screening/observability; §12.4 operational defects; §28 delivery run 4; `design/10-fixes/_0001_operator_cases.md`.
- `design/01-platform-architecture/payment_gateway_final_design-v5.md` §9.1 rules 3 and 8; `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` §3.2.

### Code paths

- `core-back/engine/workers/{workerRuntime,productionRuntime,ExpirySweeperWorker,PollWorker,InboundInboxWorker,OutboxNotificationWorker,LedgerInvariantWorker,JoinRequestExpiryWorker,PeriodicScreeningWorker,KybExpiryWorker,RetentionWorker,BackgroundJobWorker,BackgroundJobHandlers,GatewayInquirySchedules}.ts`.
- `core-back/lib/storageEngine/{outboxWorkers,outbox}.ts`, `core-back/lib/audit/writeAudit.ts`, `core-back/api/internal/checkout.ts`, `core-back/index.ts`.

### Generated appendices

`project-design/appendices/schema-catalog.md`, `env-and-config-matrix.md`, and `test-inventory.md`.

## 10. Change history

- 2026-11-03 — Baseline verification against `5a24f6f+working-tree`: documented the worker inventory, synchronous inbound path, polling SSE, outbox/audit shipping, retention exceptions, leases/backoff, startup guard, health payload, and the actual partial status of each worker.

## 11. Multi-node audit shipping (2026-11-03)

- The dedicated audit database computes the hash chain in a BEFORE INSERT trigger under `pg_advisory_xact_lock(994001)`.
- `AuditShipperWorker` inserts without `prev_hash`/`row_hash` and reads the trigger-computed values from `RETURNING`, so concurrent shippers on HOST_A and HOST_B cannot fork the chain.
- `verify_audit_chain()` is available for live gate verification and backup drill checks.
