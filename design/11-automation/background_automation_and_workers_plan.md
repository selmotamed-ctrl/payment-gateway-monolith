# Background Automation and Workers Plan

| Field | Value |
| :--- | :--- |
| Status | PLAN (FUTURE). Nothing in this document is implemented yet unless a row says so. |
| Date | 2026-11-09 |
| Verified against | `master` at `2128185` (origin `72686ec` "Review remediation rounds 1 and 2" plus four local commits) |
| Canonical part | `project-design/parts/01-core-back/05-workers.md` (inventory, contracts, status) |
| Tracker | `project-design/TRACKER.md` 2026-11-09 entry; one GAP row per automation when work starts |

This plan lists the automations the system design needs but does not have, the defects in the automations that exist, and how to build each one. Every "missing" claim below was checked against the code on the date above. Evidence is given as the search that found nothing, or the file that shows the gap. Items marked *reviewer-reported* came from the 2026-11-08 code review and were not re-checked.

## 1. What runs today

### 1.1 Core workers (`core-back/engine/workers/productionRuntime.ts`)

| Worker | Cadence | Singleton | Job |
| :--- | :--- | :--- | :--- |
| `ExpirySweeperWorker` | `WORKER_POLL_INTERVAL_MS` (5 s) | no (SKIP LOCKED) | Inquires and expires attempts past `expires_at`; releases slots. |
| `PollWorker` | 5 s | no | Inquiry schedules (`next_run_at`), route backoff, terminal transitions; releases slots for every terminal status. |
| `InboundInboxWorker` | 5 s | no | Drains `inbound_events`; idle in practice because the checkout route processes webhooks synchronously. |
| `OutboxNotificationWorker` | 5 s | no | Renders and sends queued notifications with backoff (8 attempts). |
| `LedgerInvariantWorker` | 60 s | yes | System-wide double-entry check from shard balances; P1 case on drift. |
| `LedgerCheckpointWorker` | 30 s | yes | Per-shard O(delta) checkpoints; auto-repair of drifted shards (on by default). |
| `LedgerShardScalerWorker` | 30 s | yes | Widens hot accounts (live by default, 150 lines/s threshold, 10 min cooldown, max width 64). |
| `JoinRequestExpiryWorker` | 5 s | yes | Expires abandoned drafts and overdue reviews (no audit, no merchant notice). |
| `PeriodicScreeningWorker` | 5 s, 24 h rescreen | no | L2 watch-list re-screening; suspends confirmed matches. |
| `KybExpiryWorker` | 6 h | yes | Document expiry, 30/7-day notices, grace suspension, revalidation. |
| `RetentionWorker` | 1 h, opt-in | yes | Purges expired evidence (never the ledger). |
| `OutboxRelayWorker` | 250 ms | no | Projects `attempt.transitioned` into two read models; five other topics are no-ops. |
| `AuditShipperWorker` | 500 ms, dedicated audit DB only | no | Ships the audit outbox to the hash-chained audit DB. |
| `BackgroundJobWorker` | 2 s | no (leases) | `RECONCILIATION_RUN`, `ADJUSTMENT_EXECUTION`. |

### 1.2 Outside the core

- Deploy-installed cron: `ensure_journal_line_partitions(18)` (`deploy/provisioners/postgres18Provisioner.ts`, `backupEngineProvisioner.ts`).
- Backup daemon scheduler: full, delta and drill crons (`deploy/backup-daemon`).
- Opportunistic purge of expired `session_revocations` rows on each new revocation (`core-back/lib/auth/revocation.ts:27`).

## 2. Rules every new automation follows

1. **Base class and claims.** Extend `BaseWorker` (`workerRuntime.ts`). Work that can run on many nodes claims rows with `FOR UPDATE SKIP LOCKED` inside a transaction and makes its state change conditional (`WHERE status = ...`). Work that must run once per cluster sets `singleton` and uses the advisory-lock leader election (`LEADER_ELECTION_DATABASE_URL`, never the transaction-pooled URL). New leader keys are added to `expectedLeaderKeys` automatically by registration.
2. **Switches.** Each worker gets `WORKER_<NAME>_ENABLED`, `WORKER_<NAME>_INTERVAL_MS` and, where it changes money or merchant state, a `<NAME>_DRY_RUN` that audits what it would do. Defaults: read-only and alerting workers ON; state-changing workers ON in dry run for one release, then live.
3. **Side effects.** Audit rows through `writeSystemAudit` (`engine/ledger/ledgerAlerts.ts`) with the system actor; operator escalations through `raiseLedgerCase` / `PrismaOperatorCaseSink` keyed so a repeat tick never opens a second case; merchant or staff messages through the notification outbox (template per event, tipping-off rules respected).
4. **Bounded work.** Every tick has a batch size and a time budget; no full-table scans on hot tables; indexes added in the same change when a new query needs one.
5. **Observability.** Every worker reports `lastTickAt`, `lastSuccessAt`, `lastError`, `processed` and its backlog through the health registry introduced in AUTO-03.
6. **Tests and docs.** Unit tests with fakes, a DB-backed suite under `core-back/test/` (skips without a database), the worker row in `05-workers.md`, its env keys in `env-and-config-matrix` (regenerated), and a TRACKER row.

## 3. The automations

Priority: **P0** money or availability at risk; **P1** compliance or security exposure; **P2** operational quality; **P3** design completeness.

### AUTO-01 Journal partition maintenance worker (P1)

- **Gap.** `ensure_journal_line_partitions(18)` runs from a daily cron that the deploy provisioners write (`postgres18Provisioner.ts:709-717`), and partitions already exist to 2028, so there is no near-term outage. But it is called only by that cron. A database provisioned any other way gets no new months. The function was not updated after the append-only migration, so new partitions miss the statement-level TRUNCATE guard and the role REVOKEs (*reviewer-reported*). Once a month is missing, rows go to `journal_lines_default`, and creating that month later fails because the default partition holds conflicting rows.
- **Build.** `JournalPartitionWorker` (singleton, every 6 h): ensure the next N months exist (`LEDGER_PARTITION_MONTHS_AHEAD`, default 6); install the TRUNCATE guard trigger and REVOKEs on each new partition (change `ensure_journal_line_partitions` in a migration so the cron and the worker produce the same result); count rows in `journal_lines_default` and raise a P0 case when it is not empty; offer a guarded repair job that moves default rows into a newly attached partition (detach default, create month, re-insert, re-attach) under the ledger maintenance flag.
- **Done when.** A DB test creates a database with only the current month, runs one tick and finds the guarded future partitions; a row forced into the default partition opens exactly one case.

### AUTO-02 Outbox relay dead-lettering (P0)

- **Gap.** The relay processes a batch in one transaction (`lib/storageEngine/outboxWorkers.ts:497-544`). A handler error rolls the batch back and the same lowest-id rows are selected again on every tick, so one malformed event stops every later event, including the read models. There is no attempt counter. Topics without a handler are marked processed silently.
- **Build.** Add `attempts`, `last_error` and `parked_at` to `outbox_events` (migration). On a batch failure, retry the rows one by one in savepoints; increment `attempts` on the failing row; park it after `OUTBOX_MAX_ATTEMPTS` (default 10) and raise one operator case per topic. Log and count unknown topics instead of acknowledging them silently. Expose `oldest_pending_age` for AUTO-03.
- **Done when.** A test inserts a poison event between two good ones; the good ones are projected, the poison one is parked after N ticks, and the case exists once.

### AUTO-03 Worker health and platform monitoring (P0)

- **Gap.** `05-workers.md` lists per-worker health, tick latency, backlog and last success as missing. Only the shard scaler keeps a `lastTickAt`. A stopped worker, a stale checkpoint, a growing outbox or a failing backup is noticed only by a person.
- **Build.** A `WorkerHealthRegistry` filled by `BaseWorker` (start, success, error, duration, processed) and served on the internal health endpoint. A `PlatformMonitorWorker` (singleton, 60 s) that evaluates thresholds and raises keyed cases (and later alerts) for: a worker with no success for 3x its interval; checkpoint staleness per shard (`LEDGER_CHECKPOINT_MAX_AGE_MS`); outbox and audit-outbox oldest pending age; background-job queue age; invariant status; `journal_lines_default` rows (AUTO-01); backup freshness from the daemon overview (last full and delta, archive lag, last drill); mTLS and PostgreSQL certificate expiry within 30 days; Redis reachability.
- **Done when.** Each threshold has a test that trips it once and clears it; the health endpoint lists every registered worker.

### AUTO-04 SLA and deadline escalation (P1)

- **Gap.** `slaDueAt` exists on operator cases, AML cases and join requests, and `evidenceDueAt` on disputes, but they are only counted on the dashboard (`core-back/api/internal/admin.ts:910-919`) and used as list filters. No worker reminds, escalates or applies the deadline outcome. Cash-out requests have no ageing control at all.
- **Build.** `DeadlineWorker` (singleton, 5 min): (a) reminder at a configurable lead time and an escalation case or priority bump at breach for operator cases, AML cases and join requests; (b) disputes: reminder before `evidenceDueAt`, and at the deadline either mark evidence as missed or open the decision task (the outcome is a product decision, see section 6); (c) cash-outs waiting longer than `CASHOUT_SLA_HOURS`: escalate. Every action is audited and idempotent per (subject, stage).
- **Done when.** Tests move the clock past each stage and see exactly one reminder and one escalation.

### AUTO-05 Expiry and purge sweeper for security rows (P1)

- **Gap.** Approval requests expire only when someone opens them (`approvalIsExpired` is checked lazily), so the approvals queue shows stale items and their subjects stay locked. Staff invitations past `invitationExpiresAt` are refused at accept time but never marked expired. `mfa_challenges` rows are never purged (GAP-036), and queued MFA notifications with a code payload are not scrubbed.
- **Build.** `ExpiryHousekeepingWorker` (singleton, 15 min): flip `ApprovalRequest` to `EXPIRED` past `expiresAt` (audit, notify the maker); mark expired invitations and notify the inviter; delete consumed or expired `mfa_challenges` older than 24 h; scrub `code` from sent MFA notifications; purge expired `session_revocations` in batches (today only on write).
- **Done when.** Tests cover each table, and an expired approval can no longer be approved even if the lazy check were removed.

### AUTO-06 KYB document scanning (P1)

- **Gap.** `scanKybBytes` runs once at upload (`api/internal/admin.ts:2774`, `lib/kybScan.ts`). With the production default mode the result is `PENDING`, and nothing scans again. *Reviewer-reported:* content download requires `CLEAN`, so reviewers cannot open those documents without manual action.
- **Build.** `KybScanWorker` (no singleton, SKIP LOCKED on `avStatus = 'PENDING'`): send the bytes to the configured scanner (ClamAV `clamd` socket or an HTTP scanner; this needs the real engine from GAP-025), store `CLEAN`/`INFECTED` with the engine signature version, quarantine and raise a case on `INFECTED`, retry with backoff, and re-scan `CLEAN` documents when the signature set is older than `KYB_RESCAN_DAYS`.
- **Done when.** A fake scanner test moves documents through every state; an infected file opens one case and stays undownloadable.

### AUTO-07 Statement schedules and missing-statement alerts (P1)

- **Gap.** `StatementSource.scheduleCron` is stored and editable (`api/internal/admin.ts:13188-13263`) but nothing reads it, so a configured schedule has no effect. Reconciliation runs only when someone uploads a file.
- **Build.** `StatementScheduleWorker` (singleton, 5 min): for each source with a cron, compute the expected arrival; if no reconciliation run for that period exists after a grace window, raise a "statement missing" case. Where a source has a pull connector (SFTP/API, future), enqueue a `STATEMENT_FETCH` background job. Optionally enqueue the settlement sweep after a successful run (AUTO-15).
- **Done when.** A source with a daily cron and no upload produces one case per missed day; an upload clears it.

### AUTO-08 Credential and token expiry notices (P1)

- **Gap.** `CredentialSet.expiresAt` is not read anywhere in `core-back/engine` or `lib`, so gateway credentials expire silently and the rail starts failing. `AccessToken.expiresAt` is enforced at authentication (`api/middleware/authDoubleCheck.ts:118`) but nobody is warned before it happens.
- **Build.** `ExpiryNoticeWorker` (singleton, daily): notify merchants 30, 7 and 1 days before an API token expires; notify staff and open a P1 case before a credential set expires; at expiry mark the credential set inactive and let routing fail over instead of sending requests that will be refused.
- **Done when.** Tests cover each notice stage once and the routing exclusion at expiry.

### AUTO-09 Gateway health sampling (P2)

- **Gap.** Only the synthetic seeder and one manual admin operation (`api/internal/adminOperations.ts`) write `gatewayHealthSample`. No worker probes rails or records outcomes. Whether routing reads these samples or live attempt outcomes must be traced before building.
- **Build.** `GatewayHealthWorker` (singleton, 60 s): record per-route success rate, latency and error classes from the last window of attempts, plus an active probe for rails that expose a health or inquiry endpoint; write samples; drive the route `HEALTHY/DEGRADED/DOWN` state with hysteresis; raise a case on DOWN.
- **Done when.** Fake Rails chaos (forced failures) drives a route to DEGRADED and back.

### AUTO-10 Ledger shard automation fixes (P0 for repair, P2 for scaling)

- **Auto-repair lock time (P0).** `ShardRepair.ts` takes the shard row `FOR UPDATE` and then re-runs the deep read over the shard's whole history with a 120 s statement timeout (`ShardRepair.ts:232-242`). Postings waiting on that row hit their own ~4.75 s timeout and fail. Fix: plan outside the lock; under the lock re-check only `line_seq`, balance and `max(shard_seq)` and add the lines above the planned sequence; refuse repairs above a size limit outside a maintenance window.
- **Scaler reaction (P2).** Defaults are live, 150 lines/s, two samples at 30 s, 10 min cooldown, 4x step, max width 64 (`lib/env/index.ts:161-177`). A step load is not absorbed for minutes, and TREASURY/PLATFORM_INCOME at the 15,000 TPS target need far more than 64 shards. Fix: pre-size system accounts at provisioning (`LEDGER_SYSTEM_ACCOUNT_SHARDS`, e.g. 256), shorten the cooldown for upward steps, calibrate the threshold with `core-back/test/load/ledger-load.ts` (GAP-065) on target hardware.
- **Scale-down (P3, GAP-202).** Narrow after a long dwell below a low-water mark; old shards keep their balances.

### AUTO-11 Payment link expiry sweep (P2)

- **Gap.** `PaymentLink.expiresAt` is checked when the link is opened; links are never moved to an expired state, so merchant lists and caps count them as active.
- **Build.** Add it to `ExpiryHousekeepingWorker`: mark links past `expiresAt` as `EXPIRED`, release reserved slots that are not attached to a live attempt, emit `link.expired` for the merchant webhook.

### AUTO-12 Slot and counter self-healing (P2)

- **Gap.** `PollWorker` now releases slots for every terminal status, but nothing detects drift that already happened or that a crash leaves behind (`payment_links.active_locked_count` against live attempts, daily cap counters against the read models).
- **Build.** `ConsistencyAuditWorker` (singleton, hourly): compare and report; repair only behind a dry-run flag; one case per drifted link.

### AUTO-13 Join-request expiry follow-through (P2)

- **Gap.** `JoinRequestExpiryWorker` writes no audit row and sends no merchant notice (`05-workers.md` §7).
- **Build.** Add the audit row and a merchant notification template to the existing worker.

### AUTO-14 Async inbound webhook processing (P3)

- **Gap.** The design is inbox-first; the checkout route verifies synchronously and marks the event processed even when verification fails, so the inbox worker has no producer and failures are never replayed (`05-workers.md` §7).
- **Build.** Make the route persist and return 202 for verified-signature events, let `InboundInboxWorker` process them with delayed retries (it currently retries on the next tick with no delay), and keep a synchronous path only where a rail needs an immediate answer.

### AUTO-15 Settlement sweep scheduling (P2)

- **Gap.** `SETTLEMENT_SWEEP` is posted only from the reconciliation job handler and an admin route (`BackgroundJobHandlers.ts`, `adminLedger.ts`).
- **Build.** After AUTO-07, schedule the sweep per gateway settlement calendar and alert when an expected sweep did not happen.

### AUTO-16 Regulatory report scheduling (P3, confirm intent)

- **Gap.** `RegulatoryReport` has `periodStart`/`periodEnd` and a status, but reports are created only by governance actions; nothing creates the periodic report or reminds about due filings.
- **Build (if intended).** `ReportScheduleWorker` creates DRAFT reports per reporting rule period and escalates unfiled ones through AUTO-04.

### AUTO-17 Hourly Redis backup (P3, D-09)

- Backup daemon policy for an hourly Redis snapshot with its own retention, if the design requirement still stands.

### AUTO-18 Read models and cache refresh (P3)

- `ledger.entry_posted`, `merchant.updated`, `kyb.document_uploaded`, `reconciliation.completed` and `config.invalidated` are no-ops in the relay (`outboxWorkers.ts:412-416`). Effective-dated rules are evaluated at read time, but cached catalogs (for example the visible-rails catalog) only change at their next refresh. Build the wallet-statement read model and a `config.invalidated` handler that clears caches, plus a boundary tick at each rule's `effectiveFrom`/`effectiveTo`.

## 4. Automations found by the design survey

A survey of `design/**` and `project-design/**` for everything the design says should happen on a timer or automatically, compared with the code. Items AUTO-19 to AUTO-22 and AUTO-25 were re-verified by hand on 2026-11-09; the others carry the survey's evidence and should be re-checked when the item is picked up.

### AUTO-19 Stale UNKNOWN attempts are never resolved or escalated (P0, verified)

- **Intent.** v5 design: UNKNOWN "triggers automated background inquiry/polling, statement reconciliation, or ... operator resolution" (`design/01-platform-architecture/payment_gateway_final_design-v5.md:90`); observability SLO "95% of UNKNOWN resolved within 24 h" with a stale-UNKNOWN alert (`project-design/parts/00-platform/04-observability.md:63,67`).
- **Evidence.** When the polling window elapses, `PollWorker.ts:151-161` sets `nextCheckAt = null` and marks the inquiry schedule EXPIRED, nothing else. `ExpirySweeperWorker.ts:22` excludes UNKNOWN from `EXPIRABLE_STATUSES`. The engine opens cases only for CONFLICT and LATE_SUCCESS. The attempt stays UNKNOWN forever and keeps its link slot.
- **Build.** In `PollWorker`, when the window elapses for an UNKNOWN attempt, open one keyed operator case (`kind: UNKNOWN`, SLA from settings) and hand the attempt to reconciliation matching (AUTO-23). Add a `StaleUnknownWorker` check (or a PlatformMonitor rule) that alerts on UNKNOWN older than 24 h. Never auto-fail an UNKNOWN attempt without a definitive gateway or statement answer.

### AUTO-20 Refunds stuck in EXECUTING have no follow-up (P0, verified)

- **Intent.** v5:497, "keeps Adjustment in EXECUTING and schedules reconciliation".
- **Evidence.** `ReconciliationScheduler` is an optional dependency (`DynamicRailEngine.ts:134,199`, `GovernanceExecution.ts:92,107`) and production never constructs one (no implementation anywhere). The fallback (`GovernanceExecution.ts:2451-2456`) sets `nextCheckAt` on the source attempt, which is already SUCCEEDED, and `PollWorker` only polls open or UNKNOWN attempts, so the gateway is never asked again. The refund is never booked or released, and `sumGovernanceRefunds` keeps counting it against the refundable amount.
- **Build.** A `REFUND_INQUIRY` background job type (implementing `ReconciliationScheduler`): inquire the gateway with backoff, then finalise or fail the adjustment through the existing governance path; open a case when the window elapses.

### AUTO-21 MERCHANT_DIRECT commission receivable is never netted (P0, verified)

- **Intent.** Receivable "booked & later netted" (v5:92,599); `project-design/parts/01-core-back/03-ledger.md:97`.
- **Evidence.** The `NETTING` template exists (`LedgerPoster.ts:479`) and `GovernanceExecution.ts:488` can decide `NETTING`, but no code posts `stage: "NETTING"`. The receivable grows without bound and the platform never collects merchant-direct commission.
- **Build.** A `CommissionNettingWorker` (singleton, daily or on threshold): for each merchant with a receivable, post the NETTING entry against the wallet balance available (never below the negative-balance ceiling), audit it, and pause the merchant's merchant-direct traffic when the receivable exceeds the ceiling and cannot be netted.

### AUTO-22 Emergency actions are never ratified or reverted (P1, verified)

- **Intent.** OD-9: emergency actions must be ratified within 24 h (v5:704; `project-design/parts/01-core-back/04-governance-compliance.md:73,360`).
- **Evidence.** `ratifyDueAt` is set and checked only when someone tries to ratify (`ApprovalService.ts:302,370-428`). An emergency suspension or velocity tightening that nobody ratifies stays in force indefinitely on one person's authority.
- **Build.** Add to `DeadlineWorker` (AUTO-04): reminder before `ratifyDueAt`; at breach either revert the emergency change (velocity tightening) or escalate to a P1 case (suspensions), per the policy decided in section 6.

### AUTO-23 Reconciliation exceptions, automatic dispute intake and UNKNOWN finalisation (P1)

- **Intent.** v5:441 (operator cases linked to reconciliation items, kinds UNMATCHED_STATEMENT / MISMATCH), v5:688 (webhook and statement dispute intake), v5:90.
- **Evidence (survey).** `StatementIngestor.ts:446-516` writes `AMOUNT_MISMATCH`, `MISSING_AT_GATEWAY` and `MISSING_LOCALLY` items but opens no case; `CHARGEBACK` rows are classified (`StatementIngestor.ts:7`) but no dispute is created; matched UNKNOWN attempts are not finalised.
- **Build.** Extend the `RECONCILIATION_RUN` handler: open a keyed case per exception item; create a dispute (status RECEIVED, `evidenceDueAt` from the rail's rules) for chargeback rows; finalise an UNKNOWN attempt that a statement line proves settled or failed, through the engine's finalisation path.

### AUTO-24 Event-driven AML re-screening (P1)

- **Intent.** `aml_screenings.trigger` includes LIST_UPDATE and OWNER_CHANGE (v5:456).
- **Evidence (survey).** Only ONBOARDING and PERIODIC are produced (`MerchantScreeningService.ts:265,295`, `PeriodicScreeningWorker.ts:160`); a watch-list update only clears the cache, so a new sanctions entry is checked against active merchants up to 24 h later.
- **Build.** When `PeriodicScreeningWorker` sees a new list version, enqueue a LIST_UPDATE re-screen for every active merchant and owner (batched); on an owner add or change, screen that owner immediately (OWNER_CHANGE).

### AUTO-25 KYB auto-suspension only ever sees the first 200 merchants (P1 bug, verified)

- **Evidence.** `KybExpiryWorker.ts:147-158` reads `ACTIVE` merchants `orderBy id, take batchSize` with no cursor on every tick, so merchants after the first `WORKER_KYB_EXPIRY_BATCH_SIZE` (200) are never evaluated for grace suspension.
- **Build.** Keyset cursor persisted between ticks (or a `kyb_next_check_at` column with SKIP LOCKED), plus a test with more merchants than the batch size.

### AUTO-26 Credential re-verification and refresh-failure alerts (P1, extends AUTO-08)

- **Evidence (survey).** Credential verification is manual only (`platform.ts:473`); a failed proactive token refresh only logs a warning (`ApiConsumer.ts:876-885`); `last_verified_at` and status `FAILING` (v5:404) are not maintained by any automation.
- **Build.** In `ExpiryNoticeWorker`: re-verify active credential sets on a schedule, set `FAILING` and open a case after repeated refresh failures, feed the route health of AUTO-09.

### AUTO-27 Backup failure alerts and a live audit-chain anchor (P1)

- **Evidence (survey).** Failed backup runs and drills are written to the daemon catalog only (`deploy/backup-daemon/src/scheduler.ts:253-297`); `alertLagSeconds` only flips a `healthy` flag. The daily signed audit-chain anchor (storage design §1153) does not exist; the chain is verified only on the restored copy during a drill.
- **Build.** The daemon pushes run, drill and lag events to core (or AUTO-03 polls them) and core opens cases; a daily `AuditChainAnchorWorker` verifies the live chain tail and stores a signed anchor.

### AUTO-28 Certificate renewal (P1)

- **Evidence (survey).** Internal mTLS certificates are reported but never renewed before expiry (`project-design/parts/07-deploy/02-pki.md:261`); public TLS defaults to `certbot` mode but no renewal timer is installed (`deploy/deploy.ts:250-273`).
- **Build.** A deploy-installed renewal timer for certbot with a reload hook; an mTLS rotation command in the deploy engine triggered by the AUTO-03 expiry alert (30 days).

### AUTO-29 AML batch (L4) transaction monitoring (P1)

- **Evidence (survey).** Structuring, fan-in/fan-out and other deferred patterns are designed (`04-governance-compliance.md:73,202,342`) but rules run only at attempt creation.
- **Build.** A daily `AML_BATCH_MONITORING` background job over the last window, opening AML cases with the existing case model.

### AUTO-30 Manual-instruction rails: operator SLA and auto-expiry (P2)

- **Evidence (survey).** `operator_sla_minutes` and `auto_expiry_minutes` exist (`schema.prisma:1940-1941`) but nothing reads them.
- **Build.** Honour them in the expiry sweeper and `DeadlineWorker` for bank-transfer and cash-agent rails.

### AUTO-31 Month-end merchant statement snapshot (P2)

- **Evidence (survey).** Statements are built on demand from `payment_attempts` (`merchant.ts:1513-1580`); the hash-sealed monthly statement (v5:689) does not exist.
- **Build.** A monthly `STATEMENT_CLOSE` job: ledger-based statement per wallet, stored with a content hash, immutable afterwards.

### AUTO-32 Retention coverage (P2)

- **Evidence (survey).** `RetentionWorker` is off by default and skips AML cases and screenings, KYB documents, regulatory reports, `background_jobs` and `gateway_inquiry_schedules`; it purges `audit_log` without checking `audit_outbox.shipped_at`.
- **Build.** Extend the scope per OD-4 (5 years), gate audit purges on shipped rows, enable in dry run first.

### AUTO-33 Smaller or deferred items (P2-P3)

| Item | Evidence (survey) | Build |
| :--- | :--- | :--- |
| Outbound merchant webhooks | Only described in the developer guide sample | Confirm intent; an outbox topic plus a signed delivery worker with retries |
| Automatic deploy rollback | Operator rolls back by hand (`07-health-rollback-and-recovery.md:140`) | Re-point `current` and restart the previous release on a failed health probe |
| Automatic DB failover | Only read-replica fallback exists | Ops tooling (Patroni or a promotion runbook automated by the deploy engine) |
| Log sink disk spool | A full buffer drops records (`04-observability.md:196`) | Spool to disk and replay |
| Backup schedule in Africa/Tripoli time | Scheduler is UTC only | Time-zone aware cron in the daemon |
| Backup-policy approval resume after a crash | "no automatic resume" (`09-backup-control.md:126`) | Resume pending applied approvals at boot |
| Fake Rails `autoApproveAsyncAfterSec` | Stored, never scheduled | Timer in fake-rails-back |
| Journal archive | Deferred by design (`09-future-and-unimplemented/04`) | Build with the shard-repair changes |
| False-positive suppression expiry | Suppressions are stored but never read by the screening engine (`ports.ts:242-243`) | First make suppression work, then expire it |
| Gateway route breaker | `RailRoute.healthState` is only written as HEALTHY and `countsTowardBreaker` is unused | Part of AUTO-09 |

## 5. Phased roadmap

| Phase | Items | Why first |
| :--- | :--- | :--- |
| 1. Money path and safety net | AUTO-19, AUTO-20, AUTO-21, AUTO-02, AUTO-03, AUTO-10 (repair lock), AUTO-25 | Stranded UNKNOWN payments, refunds that never finish, commission never collected, silent queue stalls, payment failures caused by repair, merchants never evaluated; and observability for everything after. |
| 2. Compliance and security timers | AUTO-04, AUTO-22, AUTO-05, AUTO-06, AUTO-08, AUTO-26, AUTO-24, AUTO-23, AUTO-27, AUTO-28, AUTO-01, AUTO-13 | Regulatory deadlines, emergency-power expiry, sanctions latency, unscanned documents, expiring credentials and certificates, backup failures nobody sees. |
| 3. Operations | AUTO-07, AUTO-09, AUTO-11, AUTO-12, AUTO-15, AUTO-29, AUTO-30, AUTO-31, AUTO-32, AUTO-10 (scaling calibration) | Reconciliation, routing and reporting quality; needs AUTO-03 for alerting. |
| 4. Design completion | AUTO-14, AUTO-16, AUTO-17, AUTO-18, AUTO-33, AUTO-10 (scale-down) | Larger changes or items whose intent must be confirmed. |

Each item ships as its own change: migration (if any), worker, env keys, tests, `05-workers.md` row, regenerated appendices, TRACKER row.

## 6. Decisions needed from the product owner

1. Dispute evidence deadline outcome: auto-mark missed and decide in the provider's favour, or only escalate to a person?
2. Cash-out SLA hours and who receives the escalation.
3. Are regulatory reports meant to be generated automatically per period (AUTO-16)?
4. Should an expired credential set take its routes out of rotation automatically (AUTO-08)?
5. Which malware scanner engine (AUTO-06, GAP-025)?
6. Target shard width for system accounts at 15,000 TPS (AUTO-10), after a run on target hardware.
7. Unratified emergency action at 24 h: revert automatically, or only escalate (AUTO-22)?
8. Commission netting cadence and what happens when the wallet cannot cover the receivable (AUTO-21).
9. Are outbound merchant webhooks part of the product (AUTO-33)?

## 7. Verification evidence (2026-11-09)

| Claim | Check |
| :--- | :--- |
| Registered workers | `grep -oE "new [A-Z][A-Za-z]+Worker\(" core-back/engine/workers/productionRuntime.ts` |
| Partition function only in deploy | `grep -rln ensure_journal_line_partitions --include=*.ts core-back deploy` finds the two provisioners and tests only |
| No gateway health writer | no `gatewayHealthSample.create/upsert` under `core-back/{engine,lib,api}` |
| KYB scanned once | `scanKybBytes` used only in `api/internal/admin.ts:2774` |
| No approval expiry sweep | no `EXPIRED` write on `approvalRequest` under `core-back/{engine,lib,api}` |
| No MFA purge | no `mfaChallenge.deleteMany` |
| Outbox has no attempt counter | no `attempts`/`parked` handling in `lib/storageEngine/outboxWorkers.ts` |
| `scheduleCron` unused | read only in `api/internal/admin.ts` (CRUD) and `engine/db/ports.ts` (type) |
| SLA fields not acted on | `slaDueAt: { lt: now }` only in dashboard counts (`admin.ts:910-919`) |
| Credential expiry unread | no `expiresAt` use for credential sets under `core-back/{engine,lib}` |
| Stale UNKNOWN stranded | `PollWorker.ts:151-161` (window elapsed: `nextCheckAt = null`, no case); `ExpirySweeperWorker.ts:22` excludes UNKNOWN |
| Refund follow-up never wired | `ReconciliationScheduler` only declared (`DynamicRailEngine.ts:134`, `GovernanceExecution.ts:92`); no implementation or construction in `core-back` |
| NETTING never posted | no `stage: "NETTING"` caller; template at `LedgerPoster.ts:479`, decision at `GovernanceExecution.ts:488` |
| Ratification deadline unenforced | `ratifyDueAt` only in `ApprovalService.ts` and `ports.ts` |
| KYB pass capped at 200 | `KybExpiryWorker.ts:147-158` (`take: batchSize`, `orderBy id`, no cursor) |
| Fixed since the review | `PollWorker` releases slots for all terminal statuses; `LEADER_ELECTION_DATABASE_URL` uses a session-pooled endpoint (`deploy/lib/hostPlanner.ts:296-299`) |

## 8. How this plan was produced

1. Inventory of registered workers, deploy crons and the backup scheduler from the code.
2. The 2026-11-08 code review findings on automations, each re-checked on `master`.
3. A survey of `design/**` and `project-design/**` for every automation the design intends (searches for schedules, timers, expiries, SLAs, retries, reminders, escalations, rotation, retention and monitoring), compared with the code; its evidence is cited per item.
4. A search of the schema for time-driven fields (`expiresAt`, `slaDueAt`, `evidenceDueAt`, `ratifyDueAt`, `scheduleCron`, effective dates) and of the code for anything that acts on them.

When an item is picked up, re-run its evidence check first: the code moves quickly, and several review findings were fixed by the 2026-11-08 remediation before this plan was written.
