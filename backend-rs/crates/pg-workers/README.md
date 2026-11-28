# pg-workers — concrete background workers (P6)

Rust port of the TypeScript worker runtime and the concrete workers of the P6 half. The runtime
(`src/runtime.rs`, `src/health.rs`) is the P6-T01 base. The workers fall into two groups: the first
six (`outbox`, `inbox`, `expiry`, `poll`, `checkpoint`, `monitor`) and the six `remaining_workers`
added for the P6-T05/T06/T08 families, with the operator-case library slice of P6-T09.

Every worker is a `Worker` (`name`, `interval`, `singleton`, `next_delay`, `tick`) and is meant to be
registered with `WorkerRuntime`. Singleton workers acquire their advisory lock through a
`LeaderLock`; `PgLeaderLock` wraps `pg_db::PgLeaderElection` (same key expression as TypeScript:
`hashtextextended('worker:' || name, 0)`), and `probe_session_safety()` is the boot proof that the
endpoint is not transaction-pooled.

## 1. Implemented

| Worker | TypeScript source | Model |
| :--- | :--- | :--- |
| `OutboxRelayWorker` (`outbox`) | `lib/storageEngine/outboxWorkers.ts:459-952` | Non-singleton. Claims `outbox_events` with `FOR UPDATE SKIP LOCKED` in one transaction, delivers inside the transaction (batch savepoint, then per-event savepoints), acknowledges, increments `attempts`, parks at `max_attempts`, audits + opens one keyed case per topic, prunes processed rows below the oldest pending id. |
| `InboundInboxWorker` (`inbox`) | `engine/workers/InboundInboxWorker.ts` | Singleton. Durable `claimed_at`/`claimed_by` lease (default 120 s); result/retry/failure writes are conditional on `claimed_by`; retryable failures retry until `max_attempts`, then a P2 `UNKNOWN` case. |
| `ExpirySweeperWorker` (`expiry`) | `engine/workers/ExpirySweeperWorker.ts` | Singleton. Claims expired attempts (`FOR UPDATE SKIP LOCKED`), asks the route when it supports inquiry, reloads, never expires an AML-held attempt or one past the point of no return with money in flight (holds it `UNKNOWN`). Terminal writes are conditional; slot release + `attempt.transitioned` outbox + audit. |
| `PollWorker` (`poll`) | `engine/workers/PollWorker.ts`, `GatewayInquirySchedules.ts` | Non-singleton. Leases due attempts by pushing `next_check_at`, polls outside the transaction through `InquiryPort`, updates open attempts conditionally, escalates a stale `UNKNOWN` to one keyed P1 case (`attempt.unknown:<id>`), maintains the manual inquiry schedule. |
| `LedgerCheckpointWorker` (`checkpoint`) | `engine/ledger/CheckpointService.ts`, `engine/workers/LedgerCheckpointWorker.ts` | Singleton. Captures per-shard checkpoints with the one-statement gapless/parity proof; a failed proof records `consecutive_failures`; the first failure opens the keyed `MISMATCH` shard case; persistent PARITY with an intact sequence and a correction within the cap is recomputed from the journal through the pure `pg-domain-ledger` planner; hourly sweep audit. |
| `PlatformMonitorWorker` (`monitor`) | `engine/workers/PlatformMonitorWorker.ts` | Singleton. Runs injected checks with a per-check timeout, turns findings into keyed `platform.<check>[:<key>]` cases (`MANUAL_REVIEW` sink by default), clears them when the source clears, rehydrates after restart, and raises `platform.monitor_check_failed:<id>` after N consecutive check failures. |
| Checks (`monitor_checks`) | `platformMonitorChecks.ts`, `backupMonitorChecks.ts`, `communicationMonitorChecks.ts`, `objectStorageMonitorChecks.ts`, `moneyPathMonitorChecks.ts` | `worker_stale`, `checkpoint_stale`, `outbox_age`, `audit_outbox_age`, `background_job_age`, `kyb_scan_backlog`, `journal_default_rows`, `cert_expiry`, `redis_unreachable`, `stale_unknown`, `refund_unscheduled`, `backup`, `communication`, `object_storage`. |
| Case library (`cases`) | `lib/operatorCases/{caseCatalog,caseService}.ts`, `engine/ledger/ledgerAlerts.ts` | `raise_keyed_case`, `clear_keyed_case` (`SOURCE_CLEARED`), `annotate_open_case`, `write_system_audit` (canonical disabled `system-drafter@payment-gateway.internal` actor), `raise_ledger_case`, the subject-key → case-type mapping the workers need. |
| `JournalPartitionWorker` (`remaining_workers::journal_partition`) | `engine/workers/JournalPartitionWorker.ts`, `engine/ledger/partitionMaintenance.ts` | Singleton, 6 h. Inspects the next `months_ahead` (1..60) months, calls the SECURITY DEFINER `ensure_journal_line_partitions` the deploy cron calls, audits `JOURNAL_PARTITIONS_ENSURED`, raises the P1 `ledger.partition.ensure_failed` / `ledger.partition.default_rows` cases (never resolves them). |
| `JoinRequestExpiryWorker` (`remaining_workers::join_request_expiry`) | `engine/workers/JoinRequestExpiryWorker.ts` | Singleton, 5 s. Expires `DRAFT` past the 30-day draft TTL and `SUBMITTED`/`IN_REVIEW`/`INFO_REQUESTED` past `sla_due_at`; each `UPDATE … RETURNING` batch runs in one transaction with its audit row and bilingual merchant notice (stable `join-request-expired:<id>` event id). `PENDING_CHECKER` untouched. |
| `ExpiryHousekeepingWorker` (`remaining_workers::expiry_housekeeping`) | `engine/workers/ExpiryHousekeepingWorker.ts` | Singleton, 15 min. Six isolated passes: expired approvals (never `EMERGENCY_RATIFICATION` or subjects with their own lifecycle) with subject release + maker notice, expired staff invitations (token revoked, queued mail suppressed), expired `PENDING` payment links (+ `link.expired` outbox), MFA challenge purge, notification secret scrub, session-revocation purge. |
| `StatementScheduleWorker` (`remaining_workers::statement_schedule`) | `engine/workers/StatementScheduleWorker.ts`, `lib/cron.ts` | Singleton, 5 min. Parses the five-field Tripoli cron, looks back 7 slots after the 120 min grace, opens one P2 `statement.missing:<source>:<slot>` case per missed slot (audit `STATEMENT_MISSING`), resolves it when a reconciliation run arrives, and reports an invalid cron once as `statement.schedule_invalid:<source>`. |
| `ConsistencyAuditWorker` (`remaining_workers::consistency_audit`) | `engine/workers/ConsistencyAuditWorker.ts` | Singleton, hourly. Compares `payment_links.active_locked_count` with the live attempts of finite-use links, one P3 `link.slot_drift:<id>` case; repairs only with `repair` (`CONSISTENCY_AUDIT_REPAIR`) under the row lock and audits `PAYMENT_LINK_SLOTS_REPAIRED`. |
| `RetentionWorker` (`remaining_workers::retention`) | `engine/workers/RetentionWorker.ts` | Singleton, hourly, off by default. OD-4 period (explicit, platform setting, else 5 years); bounded batches with a cutoff for notifications, inbound events, attempt step logs, `detail_change_logs` and `audit_log` (through the transaction-local `pgw.audit_retention` GUC); terminal attempts and their dependents only when the journal entry is retained. The ledger itself is never purged. Dry run reports without deleting. |
| Cron (`cron`) | `lib/cron.ts` | Five-field parser (`*`, `a`, `a-b`, `a,b`, `a/n`, `*/n`), day-of-month OR day-of-week rule, `last_scheduled_at_or_before` in the fixed UTC+2 Tripoli clock. |
| Notices (`notices`) | `lib/automationNotices.ts` | Bilingual in-app/e-mail templates (`JOIN_REQUEST_*`, `APPROVAL_REQUEST_EXPIRED`, `STAFF_INVITATION_EXPIRED`), `mask_notice_address`, duplicate-safe `queue_notice` on the notification outbox; the address sealer is an injected [`notices::NoticeAddressCipher`]. |

## 2. Lock model and transaction boundaries

- **Singletonty** is advisory-lock based and cluster-wide: `PgLeaderElection::try_acquire` +
  ownership re-proved every tick (`pg_backend_pid()` + the `pg_locks` row). Lost leadership skips
  the tick; nothing is retried without the lock. The endpoint must be direct PostgreSQL or the
  PgBouncer `pgw_session` alias (never the transaction pool).
- **Inbox**: claim = one `UPDATE … FROM candidate … RETURNING` statement with
  `FOR UPDATE SKIP LOCKED`; the handler runs outside that transaction and every result write carries
  `WHERE claimed_by = $worker AND processed_at IS NULL`.
- **Outbox**: selection and every acknowledgement/park update happen in one transaction; a consumer
  failure inside a savepoint rolls back only that consumer, never the acknowledgement of the rest.
  Parked escalation (audit + case) runs AFTER the park commits, in its own transactions, exactly
  like the TS `escalateParked`.
- **Poll**: the lease (`next_check_at` pushed forward) is written under the row lock, then the
  gateway call runs outside the transaction; every result write is conditional (`terminal_at IS
  NULL`).
- **Expiry**: conditional terminal writes (`terminal_at IS NULL`, `status = <observed>`, and the
  `NOT (point_of_no_return AND status IN ('AUTHORIZING','VERIFYING'))` guard) make double expiry
  impossible. The AML hold substatus is excluded in the claim and re-checked in the handler.
- **Checkpoint capture**: no shard/account lock is taken; the snapshot statement is the proof and
  the advance is a monotonic `ON CONFLICT … WHERE checkpoint_seq < excluded`.
- **Auto-repair**: reads the journal outside any lock, then applies with a compare-and-set on
  `(current_balance, line_seq)`; any posting changes those columns, so a stale plan cannot be
  applied. The shard lock is never held over the deep read (the AUTO-10 goal).
- **Monitor**: the check runs with no locks; the case sink uses the partial unique index
  `operator_cases_open_subject_key_uniq` and treats `23505` as "another node raised it first".
- **Journal partitions**: inspection and the `ensure_journal_line_partitions` call use the pool; the
  function is SECURITY DEFINER and bounded 1..60, so the application role creates only whole-month
  partitions. The audit row and the cases run after it, each in its own transaction (TS parity).
  Stranded default-partition rows are reported, never moved: the repair is an operator script.
- **Join expiry / housekeeping / statement / consistency / retention**: each batch is one
  transaction (`UPDATE … RETURNING` or a bounded `DELETE … WHERE id = ANY($1)`), so an expiry never
  commits without its audit row and notice, and a link repair re-checks the live count under the
  row lock. Retention deletes carry a cutoff in every predicate and the `audit_log` batch sets
  `pgw.audit_retention` with `set_config(..., true)` inside its transaction.
- **Statement schedule**: one case per slot keyed by the ISO slot instant; the `UNMATCHED_STATEMENT`
  partial unique index makes a repeated tick a no-op, and the case resolves itself through
  `clear_keyed_case` when the reconciliation run arrives.
- **All six** are cluster singletons (`Worker::singleton() == true`); leadership is acquired and
  re-proved every tick by `WorkerRuntime` through the shared `LeaderLock`, exactly like the earlier
  singleton workers.

## 3. Environment knobs (TypeScript names and defaults)

| Knob | Default | Used by |
| :--- | :--- | :--- |
| `WORKER_DISABLED` | empty | `WorkerRuntimeConfig::disabled` (worker name list) |
| `WORKER_POLL_INTERVAL_MS` | 5000 | inbox / expiry / poll interval |
| `WORKER_BATCH_SIZE` | 50 | inbox / expiry / poll batch |
| `WORKER_MAX_ATTEMPTS` | 3 | inbox retry limit (the worker default is 5 when unset) |
| claim lease (internal) | 120 s | inbox and poll lease |
| `OUTBOX_MAX_ATTEMPTS` | 10 | relay parking threshold |
| `STORAGE_OUTBOX_RETENTION_MS` | 3600000 (1 h) | relay prune window (`0` disables pruning) |
| prune interval / batch | 60 s / 5000 | relay prune cadence and page size |
| `WORKER_LEDGER_CHECKPOINT_ENABLED` | true | checkpoint worker registration |
| `WORKER_LEDGER_CHECKPOINT_INTERVAL_MS` | 30000 | checkpoint interval |
| `WORKER_LEDGER_CHECKPOINT_BATCH_SIZE` | 50 | checkpoint candidates per tick |
| `LEDGER_CHECKPOINT_MIN_LINES` | 5000 | candidate threshold |
| `LEDGER_CHECKPOINT_MAX_AGE_MS` | 900000 | candidate max age (`checkpoint_stale` uses 2× as its grace) |
| retry failed (internal) | 10 min | how soon a failed shard is re-tried |
| sweep audit every (internal) | 1 h | aggregated `LEDGER_CHECKPOINT_SWEEP` audit |
| `LEDGER_SHARD_AUTO_REPAIR_ENABLED` | true | automatic RECOMPUTE |
| `LEDGER_SHARD_AUTO_REPAIR_MIN_FAILURES` | 3 | persistent PARITY threshold |
| `LEDGER_SHARD_AUTO_REPAIR_MAX_ABS_DRIFT` | 100 | correction cap |
| auto-repair size/window (internal) | 500,000 lines outside the window | `repair_size_allowed` |
| `WORKER_PLATFORM_MONITOR_ENABLED` | true | monitor registration |
| `WORKER_PLATFORM_MONITOR_INTERVAL_MS` | 60000 | monitor interval |
| `PLATFORM_MONITOR_WORKER_STALE_MULTIPLIER` | 3 | `worker_stale` |
| `PLATFORM_MONITOR_OUTBOX_MAX_AGE_MS` | 300000 | `outbox_age` |
| `PLATFORM_MONITOR_AUDIT_OUTBOX_MAX_AGE_MS` | 300000 | `audit_outbox_age` |
| `WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS` | 300000 | `background_job_age` |
| `PLATFORM_MONITOR_KYB_SCAN_MAX_AGE_MS` | 7200000 | `kyb_scan_backlog` |
| `PLATFORM_MONITOR_CERT_FILES` / `PLATFORM_MONITOR_CERT_WARN_DAYS` | empty / 30 | `cert_expiry` |
| `PLATFORM_MONITOR_BACKUP_MAX_FULL_AGE_MS` | 36 h | `backup` |
| `PLATFORM_MONITOR_BACKUP_DRILL_MAX_AGE_MS` | 8 days | `backup` |
| `UNKNOWN_ATTEMPT_CASE_SLA_HOURS` | 24 | poll escalation SLA and `stale_unknown` |
| monitor check timeout (internal) | 15 s | per check |
| monitor failure threshold (internal) | 3 | `monitor_check_failed` |
| `WORKER_JOURNAL_PARTITION_INTERVAL_MS` | 21600000 (6 h) | journal partition interval |
| `LEDGER_PARTITION_MONTHS_AHEAD` | 6 (1..60) | months inspected/created ahead |
| `WORKER_EXPIRY_HOUSEKEEPING_INTERVAL_MS` | 900000 (15 min) | housekeeping interval |
| `WORKER_EXPIRY_HOUSEKEEPING_BATCH_SIZE` | 200 | housekeeping batch |
| `MFA_CHALLENGE_RETENTION_HOURS` | 24 | MFA purge cutoff |
| `NOTIFICATION_SECRET_SCRUB_AFTER_MINUTES` | 60 | sealed-secret scrub cutoff |
| `WORKER_STATEMENT_SCHEDULE_INTERVAL_MS` | 300000 (5 min) | statement schedule interval |
| `STATEMENT_SCHEDULE_GRACE_MINUTES` | 120 (0..10080) | missing-statement grace |
| `STATEMENT_SCHEDULE_LOOKBACK_SLOTS` | 7 (1..60) | slots inspected per source |
| `WORKER_CONSISTENCY_AUDIT_INTERVAL_MS` | 3600000 (1 h) | slot audit interval |
| `CONSISTENCY_AUDIT_REPAIR` | false | repair instead of report only |
| `WORKER_RETENTION_ENABLED` | false | retention registration |
| `WORKER_RETENTION_INTERVAL_MS` | 3600000 (1 h) | retention interval |
| `WORKER_RETENTION_BATCH_SIZE` | 500 | retention batch |
| `RETENTION_DRY_RUN` | false | report without deleting |

The crate does not read the environment itself; `WorkerRuntimeConfig`, `InboxConfig`, `PollConfig`,
`CheckpointConfig`, `MonitorConfig`, `OutboxRelayConfig` and `StandardChecksConfig` carry these
values, so the binary's config layer stays the only reader of `core-back/lib/env/index.ts` parity
keys.

## 4. Tests

```
cd backend-rs
cargo test -p pg-workers            # 118 DB-free unit tests + 13 database-gated tests
cargo clippy -p pg-workers --all-targets --no-deps -- -D warnings
cargo fmt -p pg-workers -- --check
```

The integration tests (`tests/db_workers.rs` and `tests/remaining_workers.rs`) use
`PG_TEST_DATABASE_URL`, defaulting to
`postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test` (schema 46). They **skip with
a message** when that database is unreachable. Each test owns uniquely-named rows and removes them
again; the append-only tables are cleaned with `pg_workers::db::APPEND_ONLY_CLEANUP_SQL`
(`SET LOCAL pgw.ledger_maintenance/append_only_maintenance/audit_retention`, superuser only).
The relay test never drains the shared outbox: it sets `OutboxRelayConfig::topics` to its own topic.
The remaining-worker tests scope statement sources by `source_ids` and links by `link_ids` so they
never touch another row's state; the retention test uses a ten-year period so only its own
four-thousand-day-old fixtures qualify.

Covered without a database: outbox delay/backoff arithmetic, parking threshold, topic registry,
selection/prune SQL shape, transitioned payload; inbox retry arithmetic and attempt parsing; expiry
predicates (money-in-flight, AML hold, expirable states, slot release) and SQL guards; poll backoff
schedule, terminal lists, lease/conditional SQL, schedule SQL; checkpoint `judge` (ADVANCED/NOOP/
GAP/PARITY), maintenance windows, repair size/allowed policy, monotonic advance SQL, CAS SQL;
monitor raise/clear/re-trip/incomplete/hydration/blind-spot behaviour against a fake sink, stale
worker decisions, backup condition keys, standard check assembly; the five-field cron parser
(ranges/lists/steps, Sunday 0 = 7, dom/dow OR rule, invalid fields, fixed-offset Tripoli wall clock,
weekend roll-back) and the retention setting parser. Covered against PostgreSQL:
relay park/audit/case/requeue, bounded prune, inbox claim ownership, checkpoint NOOP→PARITY failure
recording, monitor sink idempotency/clear/re-raise, monitor worker raising a keyed case, every
monitor check's SQL against schema 46, journal-partition creation/idempotence/audit, join-request
expiry (only past-deadline rows, one audit and two-channel notice each, idempotent), housekeeping
(approvals vs emergency/own-lifecycle, invitations, links + outbox, MFA, secret scrub, revocation
purge), statement schedule (seven cases, invalid cron once, late statement resolves), slot drift
report vs repair, and retention cutoff/dry run.

## 5. Not ported here (P6 remainder)

- `AuditShipperWorker` (dedicated audit database lease/batching) — P6-T02.
- `BackgroundJobWorker` and its handlers (`RECONCILIATION_RUN`, `ADJUSTMENT_EXECUTION`,
  `REFUND_INQUIRY`, `DISPUTE_INTAKE`, `SETTLEMENT_SWEEP`, `FEE_VARIANCE_TRUE_UP`) — P6-T03.
- `OutboxNotificationWorker`, `MerchantWebhookWorker`, the communication transports/templates and
  the tipping-off guard — P6-T04. `OutboxRelayWorker` is ready for the webhook fan-out: register an
  `OutboxConsumer` with `OutboxRegistry::with_fanout`.
- `DeadlineWorker`, `ExpiryNoticeWorker` — P6-T05 (the join-request and housekeeping families are in
  `remaining_workers`).
- `LedgerInvariantWorker`, `LedgerShardScalerWorker` — P6-T06 (journal partitions are in
  `remaining_workers`).
- `PeriodicScreeningWorker`, `KybExpiryWorker`, `KybScanWorker`, `RegulatoryReportWorker`,
  `AuditChainAnchorWorker`, `CommissionNettingWorker` — P6-T07.
- `ObjectStorageMaintenanceWorker`, `GatewayHealthWorker` — P6-T08 (statement schedule, slot audit
  and retention are in `remaining_workers`).
- The full operator-case catalogue/actions/API/backfill and Arabic labels — P6-T09 (this crate has
  the keyed raise/clear/sink slice the workers need).

## 6. Deviations from TypeScript (record in `DEVIATIONS.md` for the coordinator)

1. **Adaptive relay cadence** is exposed as `Worker::next_delay()` (additive trait method used by
   `WorkerRuntime`) instead of a private `setTimeout` loop. `next_poll_delay_ms` keeps the exact TS
   arithmetic.
2. **`OutboxRelayConfig::topics`** is an additive drain filter (`None` = every topic, TS parity).
   Tests use it so they never acknowledge another owner's events.
3. **`attempt.transitioned` read-model projector** is registered as an acknowledging consumer; the
   `rm_*` projection SQL (`projectAttemptTransitions`) is not ported. Wire a real consumer before a
   worker handover, otherwise the read models go stale when Rust drains this topic.
4. **Expiry/poll outbox events**: the TS workers leave terminal transitions to the engine's
   `updateAttempt`; the Rust port writes `attempt.transitioned` itself because it uses raw SQL. The
   payload matches `engine/runtime/attemptRepository.ts:280-297`.
5. **Auto-repair apply** uses a compare-and-set on `(current_balance, line_seq)` plus a re-read of
   the deep aggregates, instead of the TS `FOR UPDATE` + frozen-part tail read. Same guarantee (a
   concurrent posting invalidates the plan); no lock is held over the deep read.
6. **Repair planning** reuses `pg-domain-ledger::plan_shard_repair`, whose documented reduced input
   set does not carry the checkpoint pair or the per-baseline distinct count. The workers pass the
   journal total/max sequence and require the checkpoint status `PARITY` (from the database) in
   addition; `gl_shard_repairs` records the pre-repair checkpoint sequence read from the shard row.
7. **Monitor probes are traits** (`CertificateValidityReader`, `ServiceProbe`,
   `BackupOverviewSource`, `CommunicationSettingsSource`, `ObjectStorageProbe`) rather than direct
   file/HTTP/Redis calls, so the scheduler has no hidden I/O. `create_standard_platform_checks`
   skips `cert_expiry` when certificate files are configured without a reader.
8. **Communication readiness** raises the keyed case but does not fan out `COMMUNICATION_ALERT`
   notifications (that belongs to P6-T04 transports/templates).
9. **Certificates**: no X.509 parser is in the crate set yet; the reader must supply `validTo`
   (e.g. via `pg-mtls`/rcgen or the deploy PKI reader).
10. **Case catalogue** is the subset of `caseCatalog.ts` the workers' subject keys can produce;
    titles are the simple label-derived text, not the full localized catalogue.
11. **Health snapshot** gained `interval_ms`, `started_at`, `last_error_at`, `consecutive_failures`,
    `last_processed`, `processed_total` (additive to the TS view) so `worker_stale` can judge age.
12. **Repair history**: `before_checkpoint_seq` is read from the shard checkpoint at plan time
    (`deep.cp_seq`) rather than from the TS plan object; `after_checkpoint_seq` is the new high-water.
13. **Generated enums cannot be bound yet.** `pg-types` declares
    `#[sqlx(type_name = "OperatorCaseKind")]`; sqlx 0.9 resolves a custom type through
    `to_regtype(E'OperatorCaseKind')`, which lower-cases an unquoted identifier and therefore fails
    with `type named OperatorCaseKind not found`. The crate binds the text form into explicit
    `::"OperatorCaseKind"` / `::"OperatorCasePriority"` casts and proves the mapping against the
    generated enums in unit tests. The real fix is the codegen: `type_name = "\"OperatorCaseKind\""`
    (the same applies to `AttemptStatus` and the other CamelCase enum types).
14. **Tripoli cron is a fixed UTC+2 offset.** `chrono-tz` is not a dependency of `pg-workers`, and
    Libya has had no daylight saving since 2013, so `cron` resolves `Africa/Tripoli` with the fixed
    offset `TRIPOLI_UTC_OFFSET_MINUTES = 120` (and `UTC` with 0). Any other IANA name is refused
    with `CronError::UnsupportedTimeZone` instead of silently using the wrong wall clock. Replace
    `time_zone_offset_minutes` with `chrono_tz` when the dependency is accepted.
15. **Notice address sealing is an injected port.** The TypeScript helper encrypts the e-mail/SMS
    address with `Vault` (`pg-crypto`), which is not a dependency of `pg-workers`. `queue_notice`
    takes a [`notices::NoticeAddressCipher`]; without one it still queues the in-app row (empty
    ciphertext, TS parity) and skips the addressed channel with a warning, so an undeliverable
    notification is never queued silently. Inject a `pg-crypto` implementation before the worker
    handover.
16. **Retention also removes `dispute_attachments`.** The table was added after the TypeScript
    worker with `ON DELETE RESTRICT`, so the TS delete order would be refused once an attachment
    exists. The Rust worker removes the attachments before their disputes. Dependent deletes are
    bounded by the `batch_size` attempt batch rather than re-chunked inside the batch; the ledger
    (`journal_entries`/`journal_lines`) is never deleted, and its summary counters stay 0 for
    parity.
17. **Housekeeping aggregation:** the six passes always run; if any pass fails the tick returns an
    error after storing `last_summary`, which is how TypeScript both records the counts and reports
    a failing worker to the health registry.
18. **Partition worker case/audit transactions:** the TS worker calls `writeSystemAudit` and
    `raiseLedgerCase` on `db` (separate implicit transactions); the Rust port does the same. It
    never resolves the partition cases and never repairs the default partition.
19. **`RemainingWorkersConfig` is explicit.** Like the earlier workers, the crate does not read the
    environment; `create_remaining_workers` receives the six configs (including `dry_run`/`repair`)
    and the optional notice cipher from the binary's config layer, which owns the `WORKER_*`,
    `RETENTION_DRY_RUN` and `CONSISTENCY_AUDIT_REPAIR` keys.
