---
id: core.workers
title: Background Workers and Outboxes
status: partial
confidence: high
last_verified: 2026-11-07
verified_against: d695518+working-tree
code:
  - deploy/provisioners/auditAndLogDbProvisioner.ts
  - core-back/engine/workers/workerRuntime.ts
  - core-back/engine/workers/productionRuntime.ts
  - core-back/lib/storageEngine/leaderElection.ts
  - core-back/engine/workers/ExpirySweeperWorker.ts
  - core-back/engine/workers/PollWorker.ts
  - core-back/engine/workers/InboundInboxWorker.ts
  - core-back/engine/workers/OutboxNotificationWorker.ts
  - core-back/engine/workers/LedgerInvariantWorker.ts
  - core-back/engine/workers/LedgerCheckpointWorker.ts
  - core-back/engine/workers/LedgerShardScalerWorker.ts
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
  - design/11-automation/background_automation_and_workers_plan.md
tests:
  - deploy/test/testMatrix.test.ts
  - core-back/test/engine/guards-and-workers.test.ts
  - core-back/test/expiry-sweeper-aml.test.ts
  - core-back/test/expiry-sweeper-point-of-no-return.test.ts
  - core-back/test/callback-inbound-handler.test.ts
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
  - core-back/test/security-regressions/c2-mfa.test.ts
  - core-back/test/hardening-gap-regressions.test.ts
  - core-back/test/storage-engine/leader-election-pgbouncer.test.ts
gaps:
  - The trigger is installed by the deploy provisioner, not by a Prisma migration, so an externally managed audit database must run the provisioner DDL.
  - "The inbound webhook route verifies and processes synchronously; `InboundInboxWorker` is wired but has no producer, so it is effectively idle."
  - "Checkout and POS SSE streams poll the database every 2-3 seconds instead of subscribing to the transition bus."
  - "`RetentionWorker` is disabled by default, does not purge AML/KYB/reporting evidence, and does not purge the ledger by design."
  - "`OutboxRelayWorker` projects `attempt.transitioned` in batches; `ledger.entry_posted` and the other declared topics are no-ops (and `ledger.entry_posted` is no longer emitted by default), so there is no ledger-driven CQRS."
  - "`ExpirySweeperWorker`, `PollWorker`, `InboundInboxWorker`, `OutboxNotificationWorker` and `PeriodicScreeningWorker` select `FOR UPDATE SKIP LOCKED` OUTSIDE a transaction (autocommit), so the row locks are released immediately and two nodes can claim the same rows (duplicate gateway inquiries / sends). Open (GAP-DB-02)."
  - "`KybExpiryWorker` re-reads the first `batchSize` ACTIVE merchants every tick (no cursor), so later merchants are never evaluated. Open (GAP-DB-03)."
  - "`PollWorker` releases a slot for `FAILED`/`CANCELLED` but not for `EXPIRED`/`BLOCKED`, unlike the expiry sweeper's terminal release path."
  - "`JoinRequestExpiryWorker` uses raw updates without audit rows or merchant notifications."
  - "Per-worker health and metrics are not exposed; `/health` reports only durable-queue depth/age."
  - "`WORKER_CONCURRENCY` exists in env validation but is not used by the worker runtime."
  - "Singleton leader election uses a session-level advisory lock on one dedicated connection. RESOLVED 2026-11-07: the endpoint is now `LEADER_ELECTION_DATABASE_URL` (a PgBouncer `pgw_session` alias with `pool_mode=session`, or direct PostgreSQL); core refuses to boot when `PGBOUNCER_ENABLED=true` and the URL is missing or still the transaction-pooled `DATABASE_URL`, and a boot-time probe plus per-tick backend-PID/`pg_locks` ownership checks fail closed. `InboundInboxWorker` also has a durable claim lease (`claimed_at`/`claimed_by`), so even a brief leadership overlap cannot process a webhook twice. `claimLeaseSeconds` (default 120) must exceed the longest per-row processing time. FIXED 2026-11-08: the claim statement used one untyped parameter for `claimed_at` (`timestamptz`) and `updated_at` (`timestamp`), which PostgreSQL rejects with 42P08, so the worker failed every tick; both uses are now explicitly cast and `test/inbound-inbox-claim-pg.test.ts` prepares the real statement."
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
| `ExpirySweeperWorker` | `expires_at <= now`, every `WORKER_POLL_INTERVAL_MS` (5 s) | `FOR UPDATE SKIP LOCKED`, batch `WORKER_BATCH_SIZE` (50) | Inquires inquiry-capable routes first; applies definitive outcome; expires otherwise, except past the point of no return (held as `UNKNOWN` for the `PollWorker`, slot kept); excludes `AML_HOLD`; releases slot on terminal failure/expiry/cancel. | Implemented |
| `PollWorker` | `next_check_at <= now`, every poll interval | `FOR UPDATE SKIP LOCKED`, batch | Reconciles inquiry schedules, applies route backoff `[5,15,30,60,120,300]` seconds with a 900 s default window, transitions terminal states once, updates schedule metadata. | Implemented |
| `InboundInboxWorker` | `processed_at IS NULL`, every poll interval | `FOR UPDATE SKIP LOCKED`, batch | Calls the engine callback verifier, retries `RETRYABLE` errors up to `maxAttempts` (production default 3; class default 5), opens an operator case on terminal failure. | Partial / idle |
| `OutboxNotificationWorker` | `status = QUEUED` and `next_attempt_at <= now`, every poll interval | `FOR UPDATE SKIP LOCKED`, batch | Finds template, treats missing/tipping-off templates as delivery failures, redacts AML payload, renders, sends; retries with exponential backoff up to 8 attempts. | Implemented |
| `LedgerInvariantWorker` | every 60 s | Single verifier pass (O(shards)) | Verifies the system-wide invariant from the shard balances; logs drift and opens one `MISMATCH`/`P1` operator case keyed `ledger.invariant`. | Implemented |
| `LedgerCheckpointWorker` | `WORKER_LEDGER_CHECKPOINT_INTERVAL_MS` (30 s), leader-elected | Shards with the most pending lines, bounded by the batch size | Captures each shard with the verified O(delta) proof of `CheckpointService` (no locks); a failed proof opens a per-shard P1 case and an audit row; hourly `LEDGER_CHECKPOINT_SWEEP` audit summary. | Implemented |
| `LedgerShardScalerWorker` | `WORKER_LEDGER_SHARD_SCALER_INTERVAL_MS` (30 s), leader-elected | One statement over all shard sequences | Measures lines/s per shard, widens a hot account through `applyShardWidth` (live by default, audited `GL_ACCOUNT_SHARDS_SCALED`; `LEDGER_SHARD_SCALER_DRY_RUN=true` only audits `GL_ACCOUNT_SHARDS_SCALE_PROPOSED`). | Implemented |
| `JoinRequestExpiryWorker` | every poll interval, leader-elected | One `UPDATE ... RETURNING` per batch (`FOR UPDATE SKIP LOCKED`), same transaction as its audit rows and notices | Expires `DRAFT` older than 30 days and overdue `SUBMITTED`/`IN_REVIEW`/`INFO_REQUESTED` reviews; never touches `PENDING_CHECKER`; writes `JOIN_REQUEST_EXPIRED` per request (previous status in `before`) and queues a neutral merchant notice (AUTO-13). | Implemented |
| `PeriodicScreeningWorker` | every poll interval; 24 h rescreen interval | `FOR UPDATE SKIP LOCKED` on due merchants, then merchant row lock | Refreshes watch-list versions, screens merchant and owners, applies owner statuses, raises one confirmed-match case and suspends the merchant. | Implemented (L2 only) |
| `KybExpiryWorker` | every 6 h (`WORKER_KYB_EXPIRY_INTERVAL_MS`), batch 200 | Query + per-merchant transaction | Marks expired documents, queues 30/7-day notices, suspends after grace, starts periodic revalidations, expires overdue revalidations. | Implemented |
| `KybScanWorker` | every 60 s (`WORKER_KYB_SCAN_INTERVAL_MS`), batch 20 (`WORKER_KYB_SCAN_BATCH_SIZE`) | `SKIP LOCKED` claim with a 5-minute lease (not a singleton) | Scans `PENDING` KYB documents and re-scans `CLEAN` ones after `KYB_RESCAN_DAYS` with the configured engine (ClamAV `clamd`); fail closed with backoff; quarantines `INFECTED` (REJECTED, P1 case, audit, notice). Idle without a scanner. | Implemented (AUTO-06) |
| `StatementScheduleWorker` | every 5 min (`WORKER_STATEMENT_SCHEDULE_INTERVAL_MS`) | Advisory-lock singleton | Keyed missing-statement cases per scheduled slot, resolved when the statement arrives. | Implemented (AUTO-07) |
| `ConsistencyAuditWorker` | every 1 h (`WORKER_CONSISTENCY_AUDIT_INTERVAL_MS`) | Advisory-lock singleton | Reports (and, behind `CONSISTENCY_AUDIT_REPAIR`, repairs) payment-link slot counter drift. | Implemented (AUTO-12, report only by default) |
| `MerchantWebhookWorker` | every 2 s (`WORKER_MERCHANT_WEBHOOK_INTERVAL_MS`), batch 50 | `SKIP LOCKED` claim with a 2-minute lease (not a singleton) | Signs and sends merchant webhooks to the pinned public address of each endpoint, retries with exponential backoff and jitter, parks after 8 attempts, disables an endpoint after 5 days of failure. The `OutboxRelayWorker` fan-out creates the deliveries. | Implemented (AUTO-34) |
| `RegulatoryReportWorker` | every 1 h (`WORKER_REGULATORY_REPORT_INTERVAL_MS`) | Advisory-lock singleton | Drafts the scheduled returns (PSP-M, AML-Q, AML-A) per closed period and the business-day large-transaction batch; draft only, a person files. | Implemented (AUTO-16) |
| `AuditChainAnchorWorker` | every 24 h (`WORKER_AUDIT_ANCHOR_INTERVAL_MS`) | Advisory-lock singleton | Verifies the live audit hash chain since the last anchor and stores a signed anchor; incidents become keyed P1 cases. Registered only with the dedicated audit database. | Implemented (AUTO-27) |
| `RetentionWorker` | every hour when enabled; batch 500 | Bounded transactions per table | Purges notifications, inbound events, step logs, audit logs, detail logs, terminal attempts and dependents; never purges the ledger. | Partial / opt-in |
| `JournalPartitionWorker` | every 6 h (`WORKER_JOURNAL_PARTITION_INTERVAL_MS`), leader-elected | Two small catalogue reads, one DDL call only when a month is missing | Keeps the next `LEDGER_PARTITION_MONTHS_AHEAD` (6) monthly `journal_lines` partitions in existence through the same database function the deploy cron calls; raises the most-urgent cases `ledger.partition.default_rows` and `ledger.partition.ensure_failed`. | Implemented (AUTO-01) |
| `ExpiryNoticeWorker` | hourly (`WORKER_EXPIRY_NOTICE_INTERVAL_MS`), leader-elected | Staged passes, each stage exactly-once through `deadline_stages` | API token and gateway credential expiry notices at 30/7/1 days, the P1 case close to a credential expiry, expired credential sets taken out of use, scheduled credential re-verification (dry run) (section 3.16). | Implemented (AUTO-08, AUTO-26) |
| `DeadlineWorker` | every 5 min (`WORKER_DEADLINE_INTERVAL_MS`), batch 100, leader-elected | Six isolated rules, each action guarded by an exactly-once `deadline_stages` row claimed in its own transaction | Reminders, escalations and deadline outcomes for operator cases, AML cases, join requests, disputes (D1), cash-outs in Libyan business hours (D2) and unratified emergency actions (D7); section 3.16. | Implemented (AUTO-04, AUTO-22) |
| `ExpiryHousekeepingWorker` | every 15 min (`WORKER_EXPIRY_HOUSEKEEPING_INTERVAL_MS`), batch 200, leader-elected | Six bounded, index-backed, isolated passes | Closes undecided approvals, revokes expired staff invitations, expires payment links (`link.expired`), deletes old MFA challenges and session revocations, scrubs sealed secrets of finished notifications (section 3.16). | Implemented (AUTO-05, AUTO-11) |
| `PlatformMonitorWorker` | every 60 s (`WORKER_PLATFORM_MONITOR_INTERVAL_MS`), leader-elected | One pass over the configured checks | Evaluates the platform checks (section 3.16) and opens ONE keyed operator case per tripped condition (`platform.<check>[:<key>]`), recording the clearing on the case; a check that fails 3 times in a row raises `platform.monitor_check_failed:<id>`. | Implemented (AUTO-03) |
| `CommissionNettingWorker` | daily at `COMMISSION_NETTING_CRON` (00:30 Africa/Tripoli), polled every 60 s, leader-elected | One grouped receivable read, then a batch per tick within a time budget | Nets the merchant-direct commission receivable against the merchant wallet (section 3.16); dry run by default. | Implemented (AUTO-21), dry run |
| `BackgroundJobWorker` | every 2 s when enabled, batch 10 | `FOR UPDATE SKIP LOCKED` claim + ONE batch `RUNNING` update + lease | Drains `RECONCILIATION_RUN`, `ADJUSTMENT_EXECUTION` and `REFUND_INQUIRY` jobs, retries with backoff, recovers expired leases. | Implemented |
| `OutboxRelayWorker` | every 250 ms (idle back-off to 2 s), batch >= 100 | `FOR UPDATE SKIP LOCKED`, one batch ack | Projects `attempt.transitioned` into `rm_merchant_daily_stats` and `rm_route_daily_volumes`; marks `processed_at`. Other declared topics are no-ops (counted, not silent). A failing event is retried alone in a savepoint, counted in `attempts`, and PARKED after `OUTBOX_MAX_ATTEMPTS` with one operator case per topic (AUTO-02). | Partial |
| `AuditShipperWorker` | every 500 ms, batch >= 100 | Lease-claim batch then append to dedicated audit DB | Appends to the audit hash chain, then marks `audit_outbox.shipped_at`; prunes shipped rows after the retention window. | Partial / conditional |

### 3.4 Expiry sweeper

`ExpirySweeperWorker` (`core-back/engine/workers/ExpirySweeperWorker.ts`) selects attempts in `CREATED`, `INITIATING`, `AWAITING_CUSTOMER`, `AUTHORIZING`, or `VERIFYING` whose `expires_at` has passed and whose `substatus` is not `AML_HOLD`. It refreshes route inquiry support once per tick.

For each attempt:

- if the route supports inquiry and an inquiry port exists, it calls `inquire`; a definitive terminal outcome (`SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`) is applied with a conditional update; non-terminal outcomes update status/substatus and continue;
- an inquiry error moves the attempt to `UNKNOWN` with `nextCheckAt = now + 60 s`;
- with no definitive answer (no inquiry support, or a non-definitive outcome), an attempt with `point_of_no_return = true` is NOT expired: a money-moving step was already sent, so the gateway may have charged the payer. It moves to `UNKNOWN` with `next_check_at = now` (conditional on `terminal_at IS NULL` and the observed status), keeps its link slot and writes `ATTEMPT_EXPIRY_HELD_UNKNOWN`. The `PollWorker` then inquires while the route's window is open and otherwise opens one keyed `UNKNOWN` operator case (AUTO-19). Fixed 2026-11-10: before, a crash after the confirm claim left such an attempt in `AUTHORIZING`, and the sweeper expired it, released the slot and dropped it from polling;
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

`InboundInboxWorker` (`core-back/engine/workers/InboundInboxWorker.ts`) is a complete inbox drainer: it selects unprocessed events, calls the handler, marks processed/skipped/failed, retries only `RetryableInboundError`, and opens an `UNKNOWN` operator case on a terminal failure. Its production handler (`engine/workers/callbackInboundHandler.ts`) raises a TRANSIENT failure (`isTransientCallbackFailure`: Prisma/driver errors, network errno codes, PostgreSQL connection/lock/timeout/resource SQLSTATEs, our own 5xx, including through `cause`) as `RetryableInboundError`, also for a failed channel lookup; every other failure stays a skipped rejection as before (coded 4xx verdicts, and unexpected errors, so a malformed body cannot drive retries and operator cases). Fixed 2026-11-10: it used to swallow every error as SKIPPED, so a database blip during a "payment succeeded" webhook dropped the confirmation for good. It also exposes `persistInboundEvent` with a dedupe lookup and raw insert.

The actual checkout inbound route does **not** use the worker. `POST /internal/checkout/inbound/:gateway/:env/:pathToken` (`core-back/api/internal/checkout.ts:1477`) validates the channel, gateway, environment, and dedupe key, inserts the `inbound_events` row, correlates the attempt, calls `engine.verifyCallback` synchronously, and marks the event processed in the same request before returning the configured acknowledgement. The worker's handler is wired, and since 2026-11-10 the route is its producer for transient failures: when `verifyCallback` fails transiently (`inboundRouteFailureOutcome`, same classification as the worker), the route records `RETRY_PENDING` / `RETRYABLE:<code>`, leaves `processed_at` NULL so the worker claims and retries the event, and answers `503` with `Retry-After: 30` instead of the acknowledgement, so the gateway redelivers as well (finalization is idempotent per attempt, so the two paths can overlap safely). Before, the route recorded `REJECTED` and acknowledged, and the gateway never redelivered. Any other failure is still `REJECTED` and acknowledged. Synchronous verification in the route remains the main design deviation for this part.

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

### 3.8 Ledger invariant, checkpoint and shard-scaler workers

`LedgerInvariantWorker` runs `InvariantVerifier` every 60 seconds over the shard balances. On non-zero drift it logs the left/right sides, calls the optional `onDrift`, and opens a single `MISMATCH`/`P1` case (subject key `ledger.invariant`) with a four-hour SLA. It does not halt payouts itself; the operator case and the admin invariant panel are the control surface.

`LedgerCheckpointWorker` and `LedgerShardScalerWorker` are leader-elected singletons (the checkpoint capture is idempotent, so a duplicate run is harmless). The checkpoint worker keeps every shard's checkpoint close to its head; the scaler samples every shard's `line_seq` once per interval and keeps only the previous sample in leader memory (the first tick after a failover warms the baseline; the cooldown is persisted in `gl_accounts.shard_scaled_at`). Both are described in `core.ledger` 3.9; their surfaces are the GL account drawer, the Jobs & Outbox "ledger automation" tiles and the audit log.

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

`OutboxRelayWorker` (`core-back/lib/storageEngine/outboxWorkers.ts`) claims unprocessed `outbox_events` with `FOR UPDATE SKIP LOCKED` in one transaction, runs the per-topic handlers (topics with a batch handler receive all events of the batch at once), and acknowledges the whole batch with ONE `UPDATE ... WHERE id = ANY(...)`. Since 2026-11-04 an idle relay backs off exponentially (250 ms to 2 s; 500 ms to 5 s for the shipper) and re-polls immediately after a full batch. Default handlers:

| Topic | Handler |
| :--- | :--- |
| `attempt.transitioned` | Projects `rm_merchant_daily_stats` and `rm_route_daily_volumes` using the event kind (`created` vs terminal), status, merchant, route, currency, gross, and net. |
| `ledger.entry_posted` | No-op. No ledger-driven read model is projected. |
| `merchant.updated` | No-op. |
| `kyb.document_uploaded` | No-op. |
| `reconciliation.completed` | No-op. |
| `config.invalidated` | No-op. |

The relay is instantiated only when a storage engine is supplied. `attempt.transitioned` events of a batch are folded in memory (`aggregateAttemptTransitions`, decimal.js, no floats) into one delta per (merchant|route, day, currency) and applied with one `INSERT ... SELECT FROM unnest(...) ON CONFLICT DO UPDATE` per read model, sorted by key so concurrent relays lock rows in the same order. Processed rows older than `STORAGE_OUTBOX_RETENTION_MS` (default 1 h, 0 = keep) are pruned oldest-first in bounded batches strictly below the oldest unprocessed id (`OutboxRelayWorker.prune`), once a minute per worker. `rebuildAttemptReadModels(db, { fromDay, toDay })` recomputes both read models from `payment_attempts` after bulk loads.

`AuditShipperWorker` is instantiated only when `options.storage.auditStore` is a `DedicatedAuditDatabaseDriver`. It claims unshipped, unleased `audit_outbox` rows with a single `UPDATE ... SET lease_until = now() + leaseMs WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING` (the previous claim transaction committed before the append, so its `SKIP LOCKED` locks were already released while shipping and two shippers could ship the same rows), appends them to the dedicated audit database's SHA-256 hash chain, and sets `shipped_at` / clears the lease. It is idempotent on the source id; a crashed shipper's batch is re-claimed after `leaseMs` (default 30 s). Shipped rows older than `STORAGE_AUDIT_OUTBOX_RETENTION_MS` (default 1 h) are deleted by `AuditShipperWorker.prune`; the dedicated audit database is the durable copy. `writeAudit` only writes `audit_outbox` when `AUDIT_DATABASE_URL` is configured; otherwise `audit_log` is the only sink.

### 3.14 Realtime fan-out reality

The engine publishes attempt transition events on the invalidation bus, and the AML resolution path also publishes. The checkout status SSE (`core-back/api/internal/checkout.ts:1292`) and merchant POS SSE (`core-back/api/internal/merchant.ts:2392`) do **not** subscribe to that bus. They poll `payment_attempts` every 2 seconds (checkout, 10-minute deadline) or every 3 seconds (POS, 15-minute deadline) and write `event: status` / `event: attempts` frames. This is polling SSE, not a transition subscription.

### 3.15 Startup and health

`GET /health` (`core-back/index.ts:76`) reports `OK`/`DEGRADED` and a `queue` object with:

- whether workers and background jobs are enabled;
- queued job count;
- oldest queued job age;
- threshold (`WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS`, default 300 s);
- degraded flag.

It degrades when workers are disabled, the queue cannot be read, or the oldest queued job exceeds the threshold. Since AUTO-03 it also serves `workers`: one record per registered worker from the process-wide `WorkerHealthRegistry` (`lastTickAt`, `lastSuccessAt`, `lastError` as a bounded message, `lastDurationMs`, `processed`, `backlog`, `consecutiveFailures`, `leader`), informational only (it never changes `status`). The registry is filled by `BaseWorker` and by the storage-engine relay and audit shipper; the platform monitor reads it. It does not report notification backlog, inbound backlog or audit-chain status. `readBackgroundJobQueueHealth` only reads `background_jobs`.

### 3.16 Background automations, phase 1 (AUTO plan, 2026-11)

Source: `design/11-automation/background_automation_and_workers_plan.md`. Every automation below follows the plan's rules: `BaseWorker` + leader election or `SKIP LOCKED`, keyed operator cases (a repeated tick never opens a second case), system-actor audit rows, env switches, a dry run for state-changing work, and tests against live PostgreSQL.

**Worker health (AUTO-03).** `WorkerHealthRegistry` (`engine/workers/workerRuntime.ts`) is filled by `BaseWorker` on every tick (start, success, error, duration, processed count) and by `OutboxRelayWorker` / `AuditShipperWorker`, which are not `BaseWorker`s and report under their class names with the idle back-off as their cadence. `PlatformMonitorWorker` runs pluggable `PlatformMonitorCheck`s every minute and turns each finding into ONE operator case `platform.<check>[:<key>]` (kind `MANUAL_REVIEW`, SLA by priority); a condition that stops is recorded on the case (`[CLEARED ...]`, audit `PLATFORM_MONITOR_CLEARED`), never auto-resolved, and a re-trip appends `[RETRIPPED ...]`. State is rebuilt from the cases after a restart. Standard checks (`platformMonitorChecks.ts`): `worker_stale`, `checkpoint_stale`, `outbox_age`, `audit_outbox_age`, `background_job_age`, `journal_default_rows`, `cert_expiry`, `redis_unreachable`; money path (`moneyPathMonitorChecks.ts`): `stale_unknown`, `refund_unscheduled`. A check that throws or times out (15 s) three times in a row raises `platform.monitor_check_failed:<id>`.

**Outbox dead-lettering (AUTO-02).** A failing batch is retried row by row in savepoints; the failing row's `attempts` grows and `last_error` is kept; at `OUTBOX_MAX_ATTEMPTS` it is parked (`parked_at`, still `processed_at IS NULL`, so it keeps its partial-index slot and the relay no longer selects it) and one operator case `outbox.parked:<topic>` is raised with a `OUTBOX_EVENT_PARKED` audit row per event. A topic without a handler is acknowledged but marked `UNKNOWN_TOPIC` in `last_error` and counted.

**Stale UNKNOWN attempts (AUTO-19).** When the polling window of an UNKNOWN attempt elapses, `PollWorker` opens one keyed case `attempt.unknown:<attemptId>` (kind `UNKNOWN`, P1, `UNKNOWN_ATTEMPT_CASE_SLA_HOURS`) before the attempt leaves polling; if the case cannot be opened the attempt stays due and is retried after 300 s. An UNKNOWN attempt is never failed without a definitive gateway or statement answer. The monitor check `stale_unknown` alerts on UNKNOWN older than the SLA.

**Refund inquiry (AUTO-20).** `createRefundInquiryScheduler` is the production `ReconciliationScheduler`, built once in `createPlatformRuntime` and passed to the engine, every governance context and the adjustment job handler. A refund whose gateway answer is UNKNOWN stays EXECUTING and a chain of `REFUND_INQUIRY` jobs (backoff 60 s to 1 h, 24 h window) asks again by replaying the refund with the same adjustment id, only on rails that declare `capabilities.refund_idempotent`; any other rail opens the case `refund.inquiry:<adjustmentId>` at once. A definitive answer books (`finalizeReconciledRefundAdjustment`) or rejects (`failReconciledRefundAdjustment`) the adjustment; in dry run (`REFUND_INQUIRY_DRY_RUN`, default true) it audits `REFUND_INQUIRY_DRY_RUN` and opens the case instead. `refund_unscheduled` flags an EXECUTING refund with neither a job nor a case.

**Commission netting (AUTO-21, decision D8).** `engine/ledger/commissionNetting.ts` nets `min(receivable, max(0, wallet balance - open cash-outs))`, never below zero, partial, carried forward, through the existing `NETTING` stage of `MERCHANT_DIRECT_CONFIRMATION` (`Dr MERCHANT_WALLET / Cr COMMISSION_RECEIVABLE`, ref type `COMMISSION_NETTING`, ref `netting:<merchantId>:<runKey>:<receivableAccountId>`, so a repeated run never nets twice). The wallet is read under its debit lock after the posting's shard rows are locked in the global order. `CommissionNettingWorker` runs once per Tripoli day after `COMMISSION_NETTING_CRON`, opens one finance case `commission.receivable.aged:<merchantId>` for receivable older than `COMMISSION_RECEIVABLE_AGING_DAYS` that cannot be netted, audits `COMMISSION_RECEIVABLE_OVER_CEILING` and (live only) queues the merchant notice `COMMISSION_RECEIVABLE_SETTLEMENT_DUE` once per merchant and day when the remaining receivable exceeds `commissionReceivableCeiling` (the attempt guard's PAUSE decision, which now accounts for what netting could still collect, resumes traffic by itself). `executeCashout` nets first with the same arithmetic, locking the cash-out and the netting postings together (`lockShardsForMany`); the cash-out being approved is already PROCESSING, so netting can never take its money. Both start in dry run (`COMMISSION_NETTING_PROPOSED`).

**Reconciliation follow-up and the dispute deadline (AUTO-23, AUTO-04).** After a `RECONCILIATION_RUN` job ingests a statement (and again on a retried job: everything below is idempotent), `ReconciliationFollowUp` opens ONE keyed operator case per exception item (`AMOUNT_MISMATCH` kind MISMATCH P2, `MISSING_AT_GATEWAY` kind UNMATCHED_STATEMENT P2, `MISSING_LOCALLY` kind MISMATCH P3), linked both ways (`operator_cases.reconciliation_item_id`, `reconciliation_items.operator_case_id`), keyed `recon.item:<itemId>`, capped at 500 per run with one `recon.overflow:<runId>` summary. A statement CHARGEBACK row (the ingestor now stores `reconciliation_items.row_type`, schema v20) that matched one of our attempts queues the existing `DISPUTE_INTAKE` job (source STATEMENT, deduped on the live job and on (gateway, external reference)), so the dispute, the drafted chargeback adjustment and its finance approval are the same as for a webhook. A statement line proving an UNKNOWN attempt was settled is appended as `[STATEMENT EVIDENCE run <id>]` to the attempt's UNKNOWN case (`attempt.unknown:<id>`, opened if absent). DEVIATION FROM THE PLAN: the UNKNOWN attempt is NOT finalised automatically (moving money for an unresolved payment stays the operator's decision through the existing UNKNOWN resolution; the evidence and the case make it one click). Disputes had NO evidence deadline before this work (`disputes.evidence_due_at` was never set), so the dispute rules of the deadline worker had nothing to act on: the intake now sets it to the open date plus the rail's own `capabilities.dispute_evidence_days` or `DISPUTE_EVIDENCE_WINDOW_DAYS` (14), and the drafted chargeback's approval now lives until `evidence_due_at + DISPUTE_RULING_SLA_DAYS + 14 days` instead of 3 days (it would otherwise have stranded the chargeback and its escrowed reserve). `ExpiryHousekeepingWorker` also never expires approvals of subjects with their own lifecycle (adjustment, cash-out, AML case, regulatory report, dispute, KYB document, shard repair).

**Event-driven AML re-screening (AUTO-24).** `PeriodicScreeningWorker` keeps the 24 h periodic pass and adds two triggers (the merchant is never told, as before). LIST_UPDATE: the fingerprint of the published list versions is persisted in `worker_cursors` (`aml.list_fingerprint`); when it changes, including across a restart or leader change, a sweep walks the ACTIVE merchants in id order, `screenBatchSize` per tick, with the trigger `LIST_UPDATE`, its cursor persisted in `aml.list_sweep` so it resumes where it stopped; a further list change restarts it; the first fingerprint ever seen only seeds the baseline; the sweep is audited (`AML_LIST_UPDATE_SWEEP_STARTED` / `_FINISHED`). A confirmed match opens the usual case and suspends the merchant. OWNER_CHANGE: an active beneficial owner of an ACTIVE merchant that is still `NOT_SCREENED` makes the merchant and all its owners be screened with the trigger `OWNER_CHANGE` on the next tick (which sets the owner's status, so each new owner is screened once). Not detected: an EDIT of an existing owner's details (only additions are).

**Token and credential expiry (AUTO-08, AUTO-26).** `ExpiryNoticeWorker`: the merchant is told 30, 7 and 1 days before an API token expires (`API_TOKEN_EXPIRING`, once per stage; a token created with a short life skips the higher stages silently, so it gets one notice, not three); staff (GATEWAY_ADMIN, SECURITY_ADMIN) are told the same for a gateway credential set, a P1 case `credential.expiring:<id>` opens inside `CREDENTIAL_EXPIRY_CASE_DAYS`, and at `expires_at` the set is taken out of use (status FAILING, audit `CREDENTIAL_SET_EXPIRED`, case `credential.expired:<id>`, staff told; a set that expired long ago is taken out of use silently). DEVIATION FROM THE PLAN: no route is moved to OPEN_BREAKER, because the visible-rails resolver only offers a route that has a VERIFIED credential set, so a rail without one is already hidden from payers before payment and comes back by itself when a verified set exists; an OPEN_BREAKER written here would never be reset by anything. Re-verification (AUTO-26) verifies VERIFIED sets not verified for `CREDENTIAL_REVERIFY_AFTER_HOURS` through `CredentialCheckService.verify` (a real gateway call, a few per tick); a FAILING verdict opens `credential.failing:<id>` and tells staff, an unreachable verifier changes nothing; dry run by default. Not built: counting failed proactive token refreshes inside `ApiConsumer` (it still only logs).

**Deadlines (AUTO-04, AUTO-22).** `DeadlineWorker` runs six isolated rules (a failing rule is reported at the end of the tick, never stops the others). Every action is guarded by a STAGE: one `deadline_stages (subject_type, subject_id, stage)` row claimed with `INSERT ... ON CONFLICT DO NOTHING` in the SAME transaction as the action, so a restart, a repeated tick or a second node never repeats a reminder, escalation or revert (proved with three concurrent workers), and a failed action rolls its claim back so the next tick retries it. Only deadlines inside the catch-up window (`DEADLINE_CATCHUP_HOURS`, 72) are acted on, so the first run on a database full of old items does not flood staff. Staff recipients are the assignee when there is one, otherwise the ACTIVE users of a role queue (oldest first, at most 20): OPERATOR, COMPLIANCE/MLRO, FINANCE.

- **Operator cases:** a reminder `DEADLINE_REMINDER` before `sla_due_at`; at the breach the priority goes up one level (P3 to P2 to P1), the case is annotated `[SLA BREACHED ...]`, audit `OPERATOR_CASE_SLA_BREACHED`, assignee and the OPERATOR queue told. **AML cases:** a reminder to the reviewer (or MLRO/COMPLIANCE) and, at the breach, ONE keyed P1 case `aml.sla_breached:<id>`; only the case id travels in notices and the case (confidentiality). **Join requests:** a reminder only (the breach is the expiry of AUTO-13).
- **Disputes (D1):** reminders to the merchant and finance at T-72 h and T-24 h; at `evidence_due_at` with no evidence the dispute becomes `EXPIRED` (the chargeback execution already reads an EXPIRED dispute as LOST), the merchant is told, and one keyed finance case `dispute.expired:<id>` asks for the chargeback approval. DEVIATION FROM THE PLAN: the plan says the reserve loss is booked automatically; `executeAdjustment` deliberately refuses any non-human authoriser of a chargeback (design section 19.3), so the booking stays a finance decision and this worker does not bypass it (owner confirmation requested). With evidence submitted nothing is decided; a ruling overdue by `DISPUTE_RULING_SLA_DAYS` opens `dispute.ruling_overdue:<id>`.
- **Cash-outs (D2):** the operator window in Libyan business hours (`businessTime.ts`: Sunday to Thursday in Africa/Tripoli, holidays from the platform setting `calendar.holidays`, an array of `YYYY-MM-DD`); 75 % reminds finance, 100 % opens a P2 case `cashout.sla:<id>:1`, 200 % a P1 case `...:2` and tells compliance. A merchant that is not ACTIVE is in a documented hold and is not measured. When several stages are reached at once only the highest acts. P50/P90/P95 on the dashboard is not built.
- **Emergency actions (D7):** an unratified emergency approval (`mode EMERGENCY_RATIFICATION`, `PENDING_REVIEW`, no checker) gets reminders at 4 h and 1 h before `ratify_due_at` (ratifiers = MLRO and COMPLIANCE, never the actor); at the deadline a suspension STAYS in force and a P1 case `emergency.unratified:<id>` opens (audit `EMERGENCY_ACTION_UNRATIFIED`); the escalation repeats every 4 h (`EMERGENCY_ACTION_ESCALATED`); at `ratify_due_at + 48 h` a still-unratified suspension is LIFTED (the merchant returns to the status recorded in the approval's change log, the approval becomes `EXPIRED`, audit `EMERGENCY_ACTION_LIFTED`, case `emergency.lifted:<id>`, and the merchant gets only `MERCHANT_SUSPENSION_ENDED`: nothing about why or that it lapsed). The emergency suspension route now sets `expires_at = ratify_due_at + grace`, so it can still be ratified during the grace. One independent COMPLIANCE or MLRO officer may extend once by 1 to 7 days with a written reason (`POST /approvals/:id/extend-emergency`, also proxied by admin-back; never the actor; a single step by an independent officer, not a second maker-checker round); the extension clears the approval's stages so they run again. Emergency VELOCITY changes are reverted through a registered `EmergencyReverter`, but no emergency velocity flow exists yet, so none is registered: such an approval raises the P1 case saying a manual revert is needed. `ExpiryHousekeepingWorker` never touches `EMERGENCY_RATIFICATION` approvals.

**Journal partitions (AUTO-01).** `JournalPartitionWorker` calls `ensure_journal_line_partitions` (now SECURITY DEFINER, bounded 1..60, `EXECUTE` for the application role) only when a month is missing, audits `JOURNAL_PARTITIONS_ENSURED`, and raises ONE P1 case with a 2 h SLA (the plan's "P0": the most urgent priority the case model has) while rows sit in `journal_lines_default` (`ledger.partition.default_rows`) or while creating the months fails (`ledger.partition.ensure_failed`, with the database error). Moving the stranded rows edits ledger rows, which the append-only guard allows only for a superuser or a `pgw_ledger_maintenance` member, so it is an operator action: `bun run repair-journal-default-partition [--apply]` with a privileged `DATABASE_URL` (dry run by default; one transaction: copy, delete from default, create and guard the month, insert back, verify counts; ids, `created_at`, shards and sequences are unchanged; the default partition is locked ACCESS EXCLUSIVE for seconds with a 5 s lock timeout). The platform monitor's `journal_default_rows` check is the second alarm.

**Join request expiry (AUTO-13).** Each batch is one `UPDATE ... RETURNING` in the same transaction as its audit rows (`JOIN_REQUEST_EXPIRED`, previous status in `before`) and its merchant notices (`JOIN_REQUEST_DRAFT_EXPIRED` / `JOIN_REQUEST_REVIEW_EXPIRED`, EN and AR, in-app and e-mail, event id `notice:join-request-expired:<id>:<channel>` so a repeat never sends twice). The notices say nothing about screening or review findings. Notices of all automations go through `lib/automationNotices.ts` (`bilingualNotice`, `queueNotice`), which uses `INSERT ... ON CONFLICT DO NOTHING` so it is safe inside a transaction.

**Expiry housekeeping (AUTO-05, AUTO-11).** `ExpiryHousekeepingWorker` runs six isolated passes (a failing pass is reported at the end of the tick, never stops the others): (1) approvals past `expires_at` become `EXPIRED` and release their subject like a rejection; (2) a staff invitation past `invitation_expires_at` loses its token hash, its still-queued mail is suppressed and unsealed, and the inviter is told; (3) PENDING payment links past `expires_at` become `EXPIRED` with one `link.expired` outbox event per link in the same transaction (the relay acknowledges the topic; the merchant webhook, AUTO-34, will consume it); (4) MFA challenges consumed or expired for more than `MFA_CHALLENGE_RETENTION_HOURS` are deleted; (5) `codeCiphertext` / `tokenCiphertext` are removed from the payload of notifications that are no longer QUEUED after `NOTIFICATION_SECRET_SCRUB_AFTER_MINUTES`; (6) expired `session_revocations` rows are deleted. Slots reserved by a link that expired with live attempts are left to the consistency audit (AUTO-12): the attempts keep their own slots and release them when they finish. All times are compared as parameters, never `now()`, so the result does not depend on the database session time zone.

**KYB document scanning (AUTO-06, decision D5).** `KybScanWorker` (not a singleton: nodes claim with `FOR UPDATE SKIP LOCKED` and a 5-minute lease in `av_next_scan_at`, so a crashed node's claim is retried and a live one is not stolen) sends the bytes of every `PENDING` document, and of `CLEAN` documents whose last scan is older than `KYB_RESCAN_DAYS` (or never recorded), to the scanner `KYB_SCANNER_MODE` selects (`lib/kybScanner.ts`: `clamd` = ClamAV over `zINSTREAM` on a Unix socket or `host:port`, `eicar` = the built-in content gate, anything else = no scanner and every document stays `PENDING`). It is fail closed: a connection error, timeout, engine `ERROR`, size-limit reply or oversized reply rejects, the document stays `PENDING`, the error is kept in `av_last_error` and the retry backs off (`1 min * 2^(attempt-1)`, capped at 6 h); after `KYB_SCAN_MAX_ATTEMPTS` failures ONE keyed P2 case `kyb-scan-failed:<id>` is opened and the retries continue. A verdict is applied with a guarded `UPDATE ... WHERE av_status = <claimed value>`, so a document decided or replaced during the scan is never overwritten; it stores the engine and the signature set version (`av_engine`, `av_signature`, from `zVERSION`). `INFECTED` quarantines: an `UPLOADED` document becomes `REJECTED` (reason `OTHER`, system note), one audit row `KYB_DOCUMENT_QUARANTINED`, a keyed P1 case `kyb-infected:<id>`, and a neutral merchant notice (`KYB_DOCUMENT_QUARANTINED`, never names the detection). An `ACCEPTED` document that turns infected on a re-scan keeps its review status (a person decides about the merchant's KYB; the case says so), but `av_status = INFECTED` already blocks download and review. A failed RE-scan never downgrades `CLEAN`. A clean first scan writes `KYB_DOCUMENT_SCANNED`. The platform monitor adds `kyb_scan_backlog` (P2): uploaded documents `PENDING` longer than `PLATFORM_MONITOR_KYB_SCAN_MAX_AGE_MS` (only when a scanner is configured, so a dead scanner is seen). Upload-time content sniffing (active content, executables, EICAR) is unchanged and still rejects immediately.

**Backup failures and the audit-chain anchor (AUTO-27).** (1) `createBackupMonitorCheck` (`engine/workers/backupMonitorChecks.ts`, check id `backup`, registered only when `BACKUP_DAEMON_URL` is set) polls the overview `BackupControlClient` already reads and turns the daemon's own catalog into keyed operator cases `platform.backup:<key>`: `daemon` (unreachable, P1), `unhealthy` (P1), `wal-lag` (archive lag above the policy's `alertLagSeconds`, P1), `backup-failed:<target>` (the latest finished run of that target FAILED, P1; a later PASSED run clears it), `backup-stale` (no PASSED full backup within `PLATFORM_MONITOR_BACKUP_MAX_FULL_AGE_MS`, 36 h, P1), `drill-failed` (latest restore drill FAILED, carrying the double-entry, balance-parity and audit-chain numbers, P1) and `drill-stale` (no drill within `PLATFORM_MONITOR_BACKUP_DRILL_MAX_AGE_MS`, 8 days, P2). The daemon needs no push channel. (2) `AuditChainAnchorWorker` (cluster singleton, daily, only with the dedicated audit database) verifies the LIVE hash chain incrementally and stores a signed anchor in the core table `audit_chain_anchors` (append-only trigger): it checks the latest anchor's HMAC (`Vault.sign`, key `AUDIT_ANCHOR_KEY_ID`), checks that the audit database still holds the anchored row with the anchored hash (the chain alone cannot show a removed tail), verifies the rows added since the anchor in segments of `AUDIT_ANCHOR_SEGMENT_ROWS` (at most `AUDIT_ANCHOR_MAX_SEGMENTS_PER_TICK` per tick, so a long history is verified over several ticks) with `DedicatedAuditDatabaseDriver.verifyChainSegment`, then anchors the end of the verified range and writes `AUDIT_CHAIN_ANCHORED`. Failures open ONE keyed P1 case each and never move the anchor over unverified rows: `audit.anchor_invalid` (forged or edited anchor), `audit.chain_rewritten` (anchored row missing or with another hash), `audit.chain_broken` (a row does not chain; the rows before it are still anchored so the break stays located). Cases are not auto-resolved. Not built: the anchor is not yet copied outside the core database (for example to the backup store), so someone who controls both databases AND the vault key can still rewrite history consistently.

**Scheduled regulatory returns (AUTO-16, decision D3).** The provisional CBL catalogue (plan section 6.2) is DATA: migration `20261109190000_regulatory_report_automation` seeds `reporting_rules` rows (status `PROVISIONAL`, source "provisional default, pending CBL confirmation") whose `conditions` carries a `returnCode`: `PSP-M` (monthly, `dueDays` 10), `AML-Q` (quarterly, 15), `AML-A` (annual, 31) and `LTR` (`batch: BUSINESS_DAY`, LYD 50,000). `RegulatoryReportWorker` (cluster singleton, hourly) drafts them: one `DRAFT` per closed period and rule (boundaries are local midnights in `Africa/Tripoli`, `engine/workers/regulatory/periods.ts`), idempotent per `(report_code, period_key)` through a partial unique index and `ON CONFLICT DO NOTHING` (concurrent nodes draft once), `due_at` = period end + `dueDays`, payload stored encrypted (vault key `reporting-payload`, the same as the per-attempt reports) with its SHA-256, `confidential`, subject `REPORTING_RULE`, audit `REGULATORY_REPORT_DRAFTED`, MLRO and compliance told (`REGULATORY_REPORT_DRAFTED`). Only the `REGULATORY_REPORT_MAX_PERIODS` (2) most recent closed periods are considered, so enabling the worker on old data does not draft years of returns; a period that starts before the rule's effective LOCAL date is skipped. The payload sections come from read-only aggregates (`regulatory/payloads.ts`): payments by rail with success, failure and UNKNOWN rates and succeeded value, refunds, disputes opened and decided, cash-outs, merchants by status and onboarded, a funds-position reading (point in time at generation), and for AML returns screening, case and KYB counts (the number of STRs is a count only); what the platform cannot know is listed in the payload's `pending` (service availability and incidents, staff training completion, narratives). `LTR` drafts one report per business-day batch (the batch of a Thursday also holds the weekend; a holiday extends it) with every successful attempt at or above the threshold (lines capped at `REGULATORY_REPORT_MAX_BATCH_LINES`, marked `truncated`), due the end of the next business day; a batch without a breach produces no report. The per-attempt `ReportingRuleEvaluator` now skips any rule that names a `returnCode`, so a scheduled rule never fires once per payment. The `DeadlineWorker` rule `reports` watches unfiled reports (`DRAFT`, `PENDING_CHECKER`, `APPROVED`) with a `due_at`: a reminder to MLRO and compliance `REGULATORY_REPORT_REMINDER_BUSINESS_DAYS` (3) business days before, and at the due date ONE keyed P1 case `report.overdue:<id>`, audit `REGULATORY_REPORT_OVERDUE`; its catch-up window is at least 30 days so a missed filing is not forgotten. Nothing is filed: the MLRO reviews, completes the pending sections, approves and files, then records the reference. NOT BUILT: goAML XML (needs the FIU's XSD), the XLSX output through the shared export pipeline, the `INC` incident return, due dates and a draft deadline for suspicious-activity reports created by the AML flow, and a "regenerate draft" action (a correction today means a new draft by hand).

**Outbound merchant webhooks (AUTO-34, decision D9).** A merchant registers up to five HTTPS endpoints per application (`merchant_webhook_endpoints`, migration `20261109200000_merchant_webhooks`, v24) through `/internal/merchant/webhooks/*` (proxied by merchant-back, `/portal/developers/webhooks`): reading needs a merchant read authority, changing needs `application:manage`, an application-scoped user only reaches their applications, another merchant's endpoint or delivery looks nonexistent. The `whsec_` signing secret (32 random bytes) is stored vault-encrypted (key `webhook-secret`), returned exactly once by create and rotate, never listed or logged; a rotation keeps the previous secret verifying for `MERCHANT_WEBHOOK_ROTATION_OVERLAP_HOURS` (24), during which every request carries two signatures. Events: `payment.succeeded|failed|expired|refunded` (from the terminal `attempt.transitioned` outbox event; cancelled and blocked attempts are not sent), `link.expired`, `dispute.opened|closed` and `cashout.paid|failed`, each written to the transactional outbox in the same transaction as the state change (`GovernanceExecution` at the dispute intake, the ruling, the cash-out payout and rejection; the `DeadlineWorker` at a dispute expiry). The `OutboxRelayWorker` gained a `fanout` option: `createWebhookFanout` runs in the relay's own transaction and writes one `merchant_webhook_deliveries` row per matching ACTIVE endpoint (application-scoped events by application, dispute and cash-out events by merchant), idempotent through the unique `(endpoint_id, event_id)` (`evt_<outbox id>`), with the exact signed body stored as text. `MerchantWebhookWorker` (not a singleton: `FOR UPDATE SKIP LOCKED` with a 2-minute lease that already counts the attempt) signs each request with the Standard Webhooks scheme (`webhook-id`, `webhook-timestamp` per attempt, `webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>`) and sends it through `lib/webhooks/egress.ts`: HTTPS only (HTTP and private hosts only with `MERCHANT_WEBHOOK_ALLOW_INSECURE`), no URL credentials or fragments, every resolved address must be public, DNS is resolved once and the connection is PINNED to that address (a name that re-resolves to a private address cannot redirect the request; SNI and certificate validation keep the real host name), redirects are never followed, the response is read to at most 4 KiB and never stored. 2xx = delivered; network errors, timeouts, 408, 429 and 5xx retry after 5 s, 5 min, 30 min, 2 h, 5 h, 10 h and 10 h with +-20 % jitter (8 attempts, about 27 h); any other 4xx, a redirect or an unsafe URL parks the delivery at once, as does the 8th failure (`PARKED`, with `park_reason`). An endpoint that fails continuously for `MERCHANT_WEBHOOK_DISABLE_AFTER_DAYS` (5) is DISABLED (`failing_since` is cleared by any success), its pending deliveries are parked, one audit row `MERCHANT_WEBHOOK_ENDPOINT_DISABLED` is written and the merchant gets a notice (`MERCHANT_WEBHOOK_DISABLED`, host only). The merchant can send a `webhook.test` event (delivered whatever the filter), disable and enable an endpoint (enabling clears the failure streak), and redeliver a parked or delivered event as a fresh attempt cycle (the endpoint must be active); every management action is audited without the secret. Payloads carry identifiers, status and amounts only (payment: `paymentId`, `reference`, `status`, `currency`, `amount`, `netAmount`, `linkId`), never card, customer or AML data; ordering is not guaranteed. NOT BUILT: a delivery attempt history (only the last attempt is kept), `payment.refunded` for partial refunds (only the terminal `REFUNDED` status is sent), per-event retry-policy settings, and the portal has no payload viewer.

**Statement schedules and slot counter audit (AUTO-07, AUTO-12).** `StatementScheduleWorker` (cluster singleton, 5 min) reads `statement_sources.schedule_cron` (a five-field cron evaluated in `Africa/Tripoli` time by `lib/cron.ts`: lists, ranges, steps, Sunday as 0 or 7, day-of-month OR weekday when both are set) and, per source, looks at the last `STATEMENT_SCHEDULE_LOOKBACK_SLOTS` (7) slots that are more than `STATEMENT_SCHEDULE_GRACE_MINUTES` (120) old: a slot is satisfied when a `reconciliation_runs` row of the source was created at or after it and before the next slot (plus grace); an unsatisfied slot opens ONE keyed P2 case `statement.missing:<source>:<slot>` (kind `UNMATCHED_STATEMENT`, audit `STATEMENT_MISSING`), so a daily source that misses three days has three cases, and the case resolves itself with a note when the statement arrives. A source created after a slot never owes it; an invalid cron raises one P3 case `statement.schedule_invalid:<source>`. NOT BUILT: the `STATEMENT_FETCH` pull job (no connector exists) and the AUTO-15 settlement-sweep scheduling after a successful run; a statement that arrives after the NEXT slot's grace is attributed to that later slot, so the older case stays open for a person. `ConsistencyAuditWorker` (cluster singleton, hourly, REPORT ONLY) compares `payment_links.active_locked_count` with the live (non-terminal) attempts of finite-use links that have not changed for 15 minutes (an in-flight reservation would look like drift) and opens ONE P3 case `link.slot_drift:<link>` with both numbers; with `CONSISTENCY_AUDIT_REPAIR=true` it corrects the counter under the row lock (re-counting inside the lock) and audits `PAYMENT_LINK_SLOTS_REPAIRED`. The daily cap counters against the read models are not audited.

**KYB grace pass cursor (AUTO-25).** `KybExpiryWorker` walks merchants by a keyset cursor persisted in `worker_cursors`, so merchants beyond the first batch are evaluated.

**Shard repair lock time (AUTO-10).** `applyShardRepair` plans outside the shard lock and re-checks only `line_seq`, balance and `max(shard_seq)` under it, so a repair no longer holds the row for the whole-history read.

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
- Automation state (2026-11): `worker_cursors` (keyset cursors persisted by singleton workers), `outbox_events.attempts/last_error/parked_at`, `background_jobs` type `REFUND_INQUIRY`, keyed operator cases (`operator_cases.subject_key`).

### Environment keys

| Key | Default | Purpose |
| :--- | :--- | :--- |
| `WORKER_ENABLED` | `true` | Starts the runtime; false is rejected at boot because queue-only routes exist. |
| `WORKER_POLL_INTERVAL_MS`, `WORKER_BATCH_SIZE` | 5000, 50 | Base cadence and batch for most workers. |
| `WORKER_CONCURRENCY`, `WORKER_MAX_ATTEMPTS` | 4, 3 | Concurrency is validated but unused; max attempts is passed to the inbound worker. |
| `WORKER_RESCREEN_INTERVAL_MS` | 86,400,000 | Periodic screening interval. |
| `WORKER_KYB_EXPIRY_INTERVAL_MS`, `WORKER_KYB_EXPIRY_BATCH_SIZE` | 21,600,000, 200 | KYB cadence and batch. |
| `WORKER_KYB_SCAN_ENABLED`, `WORKER_KYB_SCAN_INTERVAL_MS`, `WORKER_KYB_SCAN_BATCH_SIZE` | `true`, 60,000, 20 | KYB scan worker switch, cadence, batch (AUTO-06). |
| `WORKER_AUDIT_ANCHOR_ENABLED`, `WORKER_AUDIT_ANCHOR_INTERVAL_MS` | `true`, 86,400,000 | Audit-chain anchor worker switch and cadence (AUTO-27). |
| `WORKER_REGULATORY_REPORT_ENABLED`, `WORKER_REGULATORY_REPORT_INTERVAL_MS` | `true`, 3,600,000 | Regulatory report drafting switch and cadence (AUTO-16). |
| `WORKER_MERCHANT_WEBHOOK_ENABLED`, `WORKER_MERCHANT_WEBHOOK_INTERVAL_MS`, `WORKER_MERCHANT_WEBHOOK_BATCH_SIZE` | `true`, 2000, 50 | Merchant webhook delivery switch (also switches the relay fan-out), cadence, batch (AUTO-34). |
| `WORKER_STATEMENT_SCHEDULE_ENABLED`, `WORKER_STATEMENT_SCHEDULE_INTERVAL_MS`, `STATEMENT_SCHEDULE_GRACE_MINUTES`, `STATEMENT_SCHEDULE_LOOKBACK_SLOTS` | `true`, 300,000, 120, 7 | Statement schedule alerts (AUTO-07). |
| `WORKER_CONSISTENCY_AUDIT_ENABLED`, `WORKER_CONSISTENCY_AUDIT_INTERVAL_MS`, `CONSISTENCY_AUDIT_REPAIR` | `true`, 3,600,000, `false` | Slot counter audit switch, cadence, and the repair flag (AUTO-12). |
| `MERCHANT_WEBHOOK_TIMEOUT_MS`, `MERCHANT_WEBHOOK_CONCURRENCY`, `MERCHANT_WEBHOOK_ALLOW_INSECURE`, `MERCHANT_WEBHOOK_DISABLE_AFTER_DAYS`, `MERCHANT_WEBHOOK_ROTATION_OVERLAP_HOURS` | 10,000, 8, `false`, 5, 24 | Request timeout, parallel sends per tick, development egress relaxation (HTTP and private hosts), continuous-failure days before disabling an endpoint, previous-secret overlap. |
| `REGULATORY_REPORT_MAX_PERIODS`, `REGULATORY_REPORT_MAX_BATCH_LINES`, `REGULATORY_REPORT_REMINDER_BUSINESS_DAYS` | 2, 5000, 3 | Catch-up depth, large-transaction batch cap, business days before the due date at which filers are reminded. |
| `AUDIT_ANCHOR_SEGMENT_ROWS`, `AUDIT_ANCHOR_MAX_SEGMENTS_PER_TICK`, `AUDIT_ANCHOR_KEY_ID` | 5000, 40, `audit-anchor-v1` | Rows per verification query, segments per tick, vault key that signs anchors. |
| `PLATFORM_MONITOR_BACKUP_MAX_FULL_AGE_MS`, `PLATFORM_MONITOR_BACKUP_DRILL_MAX_AGE_MS` | 129,600,000, 691,200,000 | Backup freshness limits for the `backup` monitor check (AUTO-27). |
| `KYB_SCANNER_MODE`, `KYB_CLAMD_ADDRESS`, `KYB_CLAMD_TIMEOUT_MS` | unset (= no scanner, documents stay `PENDING`), unset, 30,000 | Engine selection: `clamd` (needs the address: socket path or `host:port`), `eicar` (built-in gate, dev/tests). |
| `KYB_RESCAN_DAYS`, `KYB_SCAN_MAX_ATTEMPTS` | 30, 8 | Re-scan age of `CLEAN` documents (0 = never); failures before the P2 case. |
| `PLATFORM_MONITOR_KYB_SCAN_MAX_AGE_MS` | 7,200,000 | Age of an uploaded `PENDING` document that raises `kyb_scan_backlog`. |
| `WORKER_RETENTION_ENABLED`, `WORKER_RETENTION_INTERVAL_MS`, `WORKER_RETENTION_BATCH_SIZE` | `false`, 3,600,000, 500 | Retention enablement, cadence, batch. |
| `RETENTION_DRY_RUN` | `false` | Counts without deleting. |
| `WORKER_LEDGER_CHECKPOINT_ENABLED`, `WORKER_LEDGER_CHECKPOINT_INTERVAL_MS`, `WORKER_LEDGER_CHECKPOINT_BATCH_SIZE` | `true`, 30,000, 50 | Per-shard checkpoint worker enablement, cadence, shards per pass. |
| `LEDGER_CHECKPOINT_MIN_LINES`, `LEDGER_CHECKPOINT_MAX_AGE_MS` | 5000, 900,000 | A shard is checkpointed at this many pending lines, or when it has any and its checkpoint is older than this. |
| `LEDGER_SHARD_AUTO_REPAIR_ENABLED`, `LEDGER_SHARD_AUTO_REPAIR_MIN_FAILURES`, `LEDGER_SHARD_AUTO_REPAIR_MAX_ABS_DRIFT` | `true`, 3, 100 | Automatic repair of a persistently failing PARITY shard whose sequence is intact (recomputed from the journal); a GAP, a damaged sequence or a larger correction is left to a person. |
| `WORKER_LEDGER_SHARD_SCALER_ENABLED`, `WORKER_LEDGER_SHARD_SCALER_INTERVAL_MS` | `true`, 30,000 | Shard scaler enablement and sampling cadence. |
| `LEDGER_SHARD_SCALER_DRY_RUN` | `false` | `true` = detect and audit only; the default lets the scaler widen hot accounts (`GL_ACCOUNT_SHARDS_SCALED`). |
| `LEDGER_SHARD_UP_LINES_PER_SEC`, `LEDGER_SHARD_MAX_WIDTH`, `LEDGER_SHARD_COOLDOWN_MS` | 150, 64, 600,000 | Hot threshold per shard, widest routing width, minimum time between two scalings of an account. |
| `WORKER_BACKGROUND_JOBS_ENABLED`, `WORKER_BACKGROUND_JOBS_INTERVAL_MS`, `WORKER_BACKGROUND_JOBS_BATCH_SIZE` | `true`, 2000, 10 | Durable queue enablement, cadence, batch. |
| `WORKER_BACKGROUND_JOBS_LEASE_SECONDS`, `WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS` | 300, 300000 | Crash-recovery lease and health degradation threshold. |
| `WORKER_PLATFORM_MONITOR_ENABLED`, `WORKER_PLATFORM_MONITOR_INTERVAL_MS` | `true`, 60,000 | Platform monitor (AUTO-03) enablement and cadence. |
| `PLATFORM_MONITOR_WORKER_STALE_MULTIPLIER` | 3 | A worker with no successful tick for this many intervals is reported (P1). |
| `PLATFORM_MONITOR_OUTBOX_MAX_AGE_MS`, `PLATFORM_MONITOR_AUDIT_OUTBOX_MAX_AGE_MS` | 300,000 each | Oldest unprocessed outbox row / unshipped audit row tolerated. |
| `PLATFORM_MONITOR_CERT_FILES`, `PLATFORM_MONITOR_CERT_WARN_DAYS` | empty (the mTLS CA, server and backup-client paths), 30 | PEM files whose expiry is watched as `label=path` pairs, and the warning window. |
| `OUTBOX_MAX_ATTEMPTS` | 10 | Failed deliveries after which an outbox event is parked (AUTO-02). |
| `WORKER_EXPIRY_NOTICE_ENABLED`, `WORKER_EXPIRY_NOTICE_INTERVAL_MS` | `true`, 3,600,000 | Expiry notice worker (AUTO-08, AUTO-26). |
| `TOKEN_EXPIRY_NOTICE_DAYS`, `CREDENTIAL_EXPIRY_NOTICE_DAYS`, `CREDENTIAL_EXPIRY_CASE_DAYS` | `30,7,1`, `30,7,1`, 7 | Notice stages (days before expiry) and the window in which an expiring credential set opens a P1 case. |
| `CREDENTIAL_REVERIFY_AFTER_HOURS`, `CREDENTIAL_REVERIFY_BATCH_SIZE`, `CREDENTIAL_REVERIFY_DRY_RUN` | 24, 5, `true` | Re-verify VERIFIED credential sets not verified for this long (0 = off), sets per tick, and the dry run (audits `CREDENTIAL_REVERIFY_PROPOSED`, calls no gateway). |
| `WORKER_DEADLINE_ENABLED`, `WORKER_DEADLINE_INTERVAL_MS`, `WORKER_DEADLINE_BATCH_SIZE` | `true`, 300,000, 100 | Deadline worker (AUTO-04, AUTO-22). |
| `DEADLINE_CASE_REMINDER_LEAD_MINUTES`, `DEADLINE_JOIN_REMINDER_LEAD_HOURS`, `DEADLINE_CATCHUP_HOURS`, `DEADLINE_CASE_SLA_HOURS` | 60, 24, 72, 24 | Reminder leads, the catch-up window (only deadlines of the last N hours are acted on) and the SLA of the cases the rules open. |
| `DISPUTE_REMINDER_HOURS`, `DISPUTE_RULING_SLA_DAYS`, `DISPUTE_EVIDENCE_WINDOW_DAYS` | `72,24`, 30, 14 | Dispute evidence reminders (hours before `evidence_due_at`), the provider ruling SLA, and the default days a merchant has to answer a dispute when the rail declares none. |
| `CASHOUT_SLA_BUSINESS_HOURS`, `CASHOUT_SLA_REMINDER_RATIO` | 24, 0.75 | Cash-out operator window (business hours, Sunday to Thursday, `calendar.holidays` platform setting) and the reminder fraction. |
| `EMERGENCY_RATIFICATION_GRACE_HOURS`, `EMERGENCY_ESCALATE_EVERY_HOURS`, `EMERGENCY_REMINDER_HOURS` | 48, 4, `4,1` | Emergency ratification policy (D7): grace after the deadline before an unratified suspension is lifted, escalation period, reminders before the deadline. |
| `WORKER_JOURNAL_PARTITION_ENABLED`, `WORKER_JOURNAL_PARTITION_INTERVAL_MS`, `LEDGER_PARTITION_MONTHS_AHEAD` | `true`, 21,600,000, 6 | Journal partition worker (AUTO-01); months ahead is 1..60. |
| `WORKER_EXPIRY_HOUSEKEEPING_ENABLED`, `WORKER_EXPIRY_HOUSEKEEPING_INTERVAL_MS`, `WORKER_EXPIRY_HOUSEKEEPING_BATCH_SIZE` | `true`, 900,000, 200 | Expiry housekeeping worker (AUTO-05, AUTO-11). |
| `MFA_CHALLENGE_RETENTION_HOURS`, `NOTIFICATION_SECRET_SCRUB_AFTER_MINUTES` | 24, 60 | How long a finished MFA challenge is kept, and how long a finished notification keeps its sealed code or token. |
| `WORKER_COMMISSION_NETTING_ENABLED`, `WORKER_COMMISSION_NETTING_INTERVAL_MS` | `true`, 60,000 | Commission netting worker (AUTO-21) enablement and polling cadence. |
| `COMMISSION_NETTING_DRY_RUN` | `true` | State-changing, so it starts as a dry run (`COMMISSION_NETTING_PROPOSED` audit rows only); set `false` to net for real. |
| `COMMISSION_NETTING_CRON`, `COMMISSION_RECEIVABLE_AGING_DAYS`, `COMMISSION_NETTING_AT_CASHOUT` | `30 0 * * *`, 30, `true` | Daily run time in Africa/Tripoli, finance-case age, and netting at cash-out time. |
| `REFUND_INQUIRY_DRY_RUN`, `REFUND_INQUIRY_WINDOW_SECONDS` | `true`, 86,400 | Refund inquiry (AUTO-20): in dry run a definitive answer is audited and handed to a case; how long the gateway is asked before an operator takes over. |
| `UNKNOWN_ATTEMPT_CASE_SLA_HOURS` | 24 | SLA of the case opened for an UNKNOWN attempt whose polling window elapsed (AUTO-19) and the stale-UNKNOWN alert threshold. |

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
- **Outbox relay / audit shipper** — only `attempt.transitioned` has a projection (`ledger.entry_posted` and four other topics are no-ops); the audit shipper only runs with a dedicated audit DB (it now prunes shipped rows after the retention window).
- **Realtime fan-out** — transition events are published, but checkout/POS clients receive polling SSE, not subscriptions.

### Missing / deferred

- Background automation plan (2026-11-09): `design/11-automation/background_automation_and_workers_plan.md` lists the missing and defective automations, their design and a phased roadmap (GAP-066).
- Asynchronous webhook inbox processing on the request path.
- Transition-bus-backed SSE/WebSocket fan-out.
- Outbox and audit-outbox retention.
- Separate worker deployment/entrypoint and real `WORKER_CONCURRENCY`. (Per-worker health, tick latency and last-success metrics exist since AUTO-03; backlog is reported by the workers that know it.)
- AML/KYB/report retention passes and batch/deferred AML monitoring worker.

### Known bugs / risks

- FIXED 2026-11-08: `PollWorker` releases the slot for every terminal status (`SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`, `BLOCKED`).
- **Code gap:** the synchronous inbound route marks the event processed even when verification fails; the event is not retried by the inbox worker. Verification failure is recorded but there is no asynchronous replay.
- **Code gap:** `InboundInboxWorker` retries `RetryableInboundError` on the next tick with no delay, so a persistent retryable failure can burn its attempt cap quickly.
- **Code gap:** the inbox claim takes any row with `processed_at IS NULL`, including a webhook the synchronous route is still verifying, so the two can verify the same event concurrently (money-safe: finalization is claimed once per attempt; the work is duplicated). Bound the claim by `received_at` age or a route-owned claim.
- FIXED: balances are read from the shards only (`loadLiveAccountBalances`), so no checkpoint fallback can double count.
- **Risk:** retention and audit shipping are independent: retention purges `audit_log` and `detail_change_logs` on its own schedule without consulting `audit_outbox.shipped_at`, and the outbox rows are never purged.
- **Risk:** `OutboxRelayWorker` still acknowledges a topic without a consumer (a newer node may emit topics an older relay does not know), but it is now counted and marked `UNKNOWN_TOPIC` in `last_error` instead of silent (AUTO-02).
- **Documentation gap:** the design describes an event-driven realtime and inbox-first system; the as-built system is synchronous on inbound and polling on SSE.

## 8. Verification and tests

Run:

```bash
cd core-back && bun test test/expiry-sweeper-aml.test.ts test/expiry-sweeper-point-of-no-return.test.ts
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
- `callback-inbound-handler.test.ts` — the inbox callback handler retries transient failures (database, driver, network, SQLSTATE, our 5xx, wrapped causes, a failed channel lookup) and keeps verdicts and unexpected errors as rejections; the inbox retries a webhook after a database blip and then processes it; the synchronous route's `inboundRouteFailureOutcome` (REJECTED and acknowledged vs `RETRY_PENDING`, `processed_at` NULL, 503).
- `expiry-sweeper-point-of-no-return.test.ts` — an expired `AUTHORIZING`/`VERIFYING` attempt past the point of no return becomes `UNKNOWN` (conditional update, slot kept, audit row), also after a non-definitive inquiry; a definitive answer still wins; a lost race writes nothing; an attempt before the point of no return still expires.
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

## 11. Security hardening (2026-11-05)

- `OutboxNotificationWorker` opens the Vault-encrypted `codeCiphertext` of SMS MFA notifications at send time; `notifications.payload_json` no longer carries the plaintext code.
- **Multi-node claiming and leader election (GAP-012, RESOLVED 2026-11-05).** Every `FOR UPDATE SKIP LOCKED` claim now runs inside a transaction (`BaseWorker.inTransaction`, 15 s timeout, 5 s max wait; a test double without `$transaction` runs the callback directly), because a SKIP LOCKED lock taken outside a transaction is released the instant the statement ends. `PollWorker` (`payment_attempts.next_check_at`) and `OutboxNotificationWorker` (`notifications.next_attempt_at`) claim and lease in ONE statement: the claimed rows are updated to `now + claimLeaseSeconds` (`WorkerOptions.claimLeaseSeconds`, default 120 s) before the lock is released at commit, the inquiry/delivery then runs outside the transaction (a held row lock would deadlock the engine, which updates the same attempt on another connection), every outcome rewrites the schedule column, and a crashed node's rows become due again when the lease expires. `ExpirySweeperWorker` has no lease column and is a cluster singleton whose exclusivity comes from leader election (the conditional terminal transition remains the last line of defence). `InboundInboxWorker` is also a singleton, but since 2026-11-07 it additionally owns a durable `claimed_at`/`claimed_by` lease, so even a brief leadership overlap cannot process a webhook twice. Singleton workers (`BaseWorker.singleton`): `ExpirySweeper`, `InboundInbox`, `JoinRequestExpiry`, `KybExpiry`, `LedgerInvariant`, `PeriodicScreening` and `Retention`. Their tick runs only on the node that holds the PostgreSQL advisory lock for `worker:<name>` (`PgAdvisoryLeaderElection`, `core-back/lib/storageEngine/leaderElection.ts`; the lock name is `<namespace>:worker:<name>`, default namespace `pgw`, hashed with `hashtextextended`). It uses `pg_try_advisory_lock` on ONE dedicated, session-stable connection (`application_name=pg-core-back-leader`). Since 2026-11-07 the storage engine creates the election from `LEADER_ELECTION_DATABASE_URL` (falling back to `DATABASE_URL` only when PgBouncer is disabled), and a leader re-validates on every tick with a combined backend-PID + `pg_locks` ownership probe; a change, a missing lock row, a refused unlock or a dropped connection clears the held keys and the singleton skips the tick (fail closed). Boot runs `verifySessionSafety()`: a second client must not be able to acquire the probe key and the backend PID must stay stable, otherwise core refuses to start. Deploy generates a `pgw_session` PgBouncer alias with `pool_mode=session`; the transaction-pooled `DATABASE_URL` is rejected by the environment guard when `PGBOUNCER_ENABLED=true`. `createProductionWorkerRuntime` passes the election to the workers and registers the expected singleton keys on it for `/health`. Without an election (unit tests, single-process) workers behave as before.
- The re-finalize guard for terminal attempts in `verifyCallback`/`finalizeSuccess` is implemented in the engine (GAP-016, RESOLVED 2026-11-05; see `core.engine`). `PollWorker`/`ExpirySweeper` still never settle an AML-held attempt (`AML_HOLD` substatus).
