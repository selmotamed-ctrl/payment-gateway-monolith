# Background Automation and Workers Plan

| Field | Value |
| :--- | :--- |
| Status | FINAL PLAN, ready for implementation (FUTURE: nothing here is built yet unless a row says so). All decisions are taken (section 6). The regulatory report catalogue is a provisional default until the CBL confirms it (section 6.2). |
| Date | 2026-11-09 (finalised the same day) |
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
- **Build.** `DeadlineWorker` (singleton, 5 min): (a) reminder at a configurable lead time and an escalation case or priority bump at breach for operator cases, AML cases and join requests; (b) disputes: reminder before `evidenceDueAt`, and at the deadline either mark evidence as missed or open the decision task (decided in section 6, D1: lost by default); (c) cash-outs past the business-hour SLA in section 6, D2: remind, then escalate. Every action is audited and idempotent per (subject, stage).
- **Done when.** Tests move the clock past each stage and see exactly one reminder and one escalation.

### AUTO-05 Expiry and purge sweeper for security rows (P1)

- **Gap.** Approval requests expire only when someone opens them (`approvalIsExpired` is checked lazily), so the approvals queue shows stale items and their subjects stay locked. Staff invitations past `invitationExpiresAt` are refused at accept time but never marked expired. `mfa_challenges` rows are never purged (GAP-036), and queued MFA notifications with a code payload are not scrubbed.
- **Build.** `ExpiryHousekeepingWorker` (singleton, 15 min): flip `ApprovalRequest` to `EXPIRED` past `expiresAt` (audit, notify the maker); mark expired invitations and notify the inviter; delete consumed or expired `mfa_challenges` older than 24 h; scrub `code` from sent MFA notifications; purge expired `session_revocations` in batches (today only on write).
- **Done when.** Tests cover each table, and an expired approval can no longer be approved even if the lazy check were removed.

### AUTO-06 KYB document scanning (P1)

- **Gap.** `scanKybBytes` runs once at upload (`api/internal/admin.ts:2774`, `lib/kybScan.ts`). With the production default mode the result is `PENDING`, and nothing scans again. *Reviewer-reported:* content download requires `CLEAN`, so reviewers cannot open those documents without manual action.
- **Build.** `KybScanWorker` (no singleton, SKIP LOCKED on `avStatus = 'PENDING'`): send the bytes to the configured scanner (ClamAV `clamd`, decided in section 6, D5), store `CLEAN`/`INFECTED` with the engine signature version, quarantine and raise a case on `INFECTED`, retry with backoff, and re-scan `CLEAN` documents when the signature set is older than `KYB_RESCAN_DAYS`.
- **Done when.** A fake scanner test moves documents through every state; an infected file opens one case and stays undownloadable.

### AUTO-07 Statement schedules and missing-statement alerts (P1)

- **Gap.** `StatementSource.scheduleCron` is stored and editable (`api/internal/admin.ts:13188-13263`) but nothing reads it, so a configured schedule has no effect. Reconciliation runs only when someone uploads a file.
- **Build.** `StatementScheduleWorker` (singleton, 5 min): for each source with a cron, compute the expected arrival; if no reconciliation run for that period exists after a grace window, raise a "statement missing" case. Where a source has a pull connector (SFTP/API, future), enqueue a `STATEMENT_FETCH` background job. Optionally enqueue the settlement sweep after a successful run (AUTO-15).
- **Done when.** A source with a daily cron and no upload produces one case per missed day; an upload clears it.

### AUTO-08 Credential and token expiry notices (P1)

- **Gap.** `CredentialSet.expiresAt` is not read anywhere in `core-back/engine` or `lib`, so gateway credentials expire silently and the rail starts failing. `AccessToken.expiresAt` is enforced at authentication (`api/middleware/authDoubleCheck.ts:118`) but nobody is warned before it happens.
- **Build.** `ExpiryNoticeWorker` (singleton, daily): notify merchants 30, 7 and 1 days before an API token expires; notify staff and open a P1 case before a credential set expires; at expiry mark the credential set inactive and move its routes to `OPEN_BREAKER` (section 6, D4).
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

### AUTO-16 Regulatory report generation and filing deadlines (P1, decided in section 6, D3)

- **Gap.** `RegulatoryReport` has `periodStart`/`periodEnd`, an encrypted payload with a SHA-256, a submission reference and a maker-checker status flow (`DRAFT -> PENDING_CHECKER -> APPROVED -> SUBMITTED -> ACKNOWLEDGED / REJECTED_BY_AUTHORITY`), but reports are created only by governance actions (`api/internal/admin.ts`). Nothing generates the periodic returns, batches large transactions, or tracks a filing due date.
- **Build.**
  - **Catalogue as data.** The provisional report catalogue in section 6.2 is seeded as `reporting_rules` rows with status `PROVISIONAL` and `sourceReference` "provisional default, pending CBL confirmation". Each periodic return is a `PERIODIC_RETURN` rule whose `conditions` JSON carries `returnCode`, `period` (`MONTHLY`, `QUARTERLY`, `ANNUAL`), `dueDays` after period end, and the sections to include. Confirming a rule with the CBL is a maker-checker change to `CONFIRMED` with the real source reference; no code changes.
  - **Due dates.** Migration: add `due_at` to `regulatory_reports`, set from the rule when the draft is created.
  - **Worker.** `RegulatoryReportWorker` (singleton, hourly):
    - creates one DRAFT per periodic rule at each period end (idempotent per rule and period);
    - batches the previous business day's threshold breaches into one `LARGE_TRANSACTION` draft;
    - hands overdue drafts to `DeadlineWorker` (AUTO-04): reminder at `due_at` minus 3 business days, P1 case to the MLRO at `due_at`.
  - **Outputs.** The JSON payload stays encrypted in the row. A human-readable XLSX goes through the shared XLSX pipeline, as AGENTS.md requires. Suspicious-activity and large-transaction reports also produce a goAML XML file for upload to the Financial Information Unit's goAML portal. The goAML mapping sits behind an adapter that is validated against the FIU's own XSD once the FIU provides it.
  - **Filing stays human.** The MLRO approves and uploads, then records the goAML or CBL reference in `submissionRef`; the status moves to `SUBMITTED`, and later `ACKNOWLEDGED` or `REJECTED_BY_AUTHORITY`. Suspicious-activity reports are never generated from a merchant-visible path, never notify the merchant, and are visible only to `aml:read_confidential` holders.
- **Done when.** Tests cover period roll-over (month, quarter, year, in `Africa/Tripoli`), idempotency per period, the large-transaction batch, due-date escalation, and a goAML XML that validates against a sample XSD.

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
- **Build (policy decided in section 6, D7: the split).** Add to `DeadlineWorker` (AUTO-04):
  - **Reminders.** At `ratifyDueAt` minus 4 h and minus 1 h, remind the MLRO and every compliance officer who can ratify (anyone except the actor).
  - **Velocity changes at `ratifyDueAt` (24 h).** Revert the emergency velocity or limit change to the last ratified values, with an audit row (`EMERGENCY_ACTION_REVERTED`) and a P1 case that records it.
  - **Suspensions at `ratifyDueAt`.** Keep the suspension in force and open a P1 case to the MLRO; repeat the escalation every 4 h.
  - **Suspensions at `ratifyDueAt + 48 h`.** If still unratified and not extended, lift the suspension with an audit row and a P1 case; the merchant is notified only that the suspension ended, with no compliance detail (tipping-off).
  - **Extension.** A second compliance officer, not the actor, may extend an emergency suspension once, by up to 7 days, with a written reason. An extension is itself a maker-checker action.
  - **Idempotency.** Every step is keyed per (approval request, stage), so a restart never reverts twice.

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
| Automatic deploy rollback | Operator rolls back by hand (`07-health-rollback-and-recovery.md:140`) | Re-point `current` and restart the previous release on a failed health probe |
| Automatic DB failover | Only read-replica fallback exists | Ops tooling (Patroni or a promotion runbook automated by the deploy engine) |
| Log sink disk spool | A full buffer drops records (`04-observability.md:196`) | Spool to disk and replay |
| Backup schedule in Africa/Tripoli time | Scheduler is UTC only | Time-zone aware cron in the daemon |
| Backup-policy approval resume after a crash | "no automatic resume" (`09-backup-control.md:126`) | Resume pending applied approvals at boot |
| Fake Rails `autoApproveAsyncAfterSec` | Stored, never scheduled | Timer in fake-rails-back |
| Journal archive | Deferred by design (`09-future-and-unimplemented/04`) | Build with the shard-repair changes |
| False-positive suppression expiry | Suppressions are stored but never read by the screening engine (`ports.ts:242-243`) | First make suppression work, then expire it |
| Gateway route breaker | `RailRoute.healthState` is only written as HEALTHY and `countsTowardBreaker` is unused | Part of AUTO-09 |

### AUTO-34 Outbound merchant webhooks (P1, decided in section 6)

- **Gap.** The merchant guide already teaches merchants to verify signed webhooks (`X-PG-Signature`) and its code generator produces verification code, but no merchant webhook exists: `project-design/parts/04-merchant-front/01-guide-and-developer-api.md:23` says "outbound merchant webhooks are not implemented", and `Application` has no endpoint field. Merchants can only learn a payment outcome by polling or from the browser return.
- **Build.**
  - **Data.** Per-application endpoint URL, signing secret (`whsec_` style, stored with the Vault like credential sets, rotation with two active secrets for an overlap window), enabled event types, and a `merchant_webhook_deliveries` table (event id, attempt, status code, latency, next attempt).
  - **Events.** `payment.succeeded`, `payment.failed`, `payment.expired`, `payment.refunded`, `dispute.opened`, `dispute.closed`, `cashout.paid`, `cashout.failed`, `link.expired`, produced through the transactional outbox in the same transaction as the state change.
  - **Signing.** The [Standard Webhooks](https://www.standardwebhooks.com/) scheme: headers `webhook-id` (stable per event), `webhook-timestamp` (per attempt) and `webhook-signature` = base64 HMAC-SHA256 over `id.timestamp.body`. Update the guide and its code generator from `X-PG-Signature` to these headers.
  - **Delivery.** A `MerchantWebhookWorker` (SKIP LOCKED, many nodes): exponential backoff with jitter (immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h; about 27 h in total), retry on network errors, 408, 429 and 5xx, give up on other 4xx; after the last attempt park the delivery, show it in the merchant portal with a manual "redeliver" button, and disable an endpoint that has failed for 5 days with a notice to the merchant.
  - **Safety.** Destination URLs go through the same egress rules as the API consumer (HTTPS only in production, no private or loopback ranges, DNS pinned at connect, redirects not followed); payloads carry ids and amounts, never card data or AML information; ordering is not guaranteed and the guide says so (merchants should fetch the payment when in doubt).

## 5. Phased roadmap

| Phase | Items | Why first |
| :--- | :--- | :--- |
| 1. Money path and safety net | AUTO-19, AUTO-20, AUTO-21, AUTO-02, AUTO-03, AUTO-10 (repair lock), AUTO-25 | Stranded UNKNOWN payments, refunds that never finish, commission never collected, silent queue stalls, payment failures caused by repair, merchants never evaluated; and observability for everything after. |
| 2. Compliance and security timers | AUTO-04, AUTO-22, AUTO-16, AUTO-34, AUTO-05, AUTO-06, AUTO-08, AUTO-26, AUTO-24, AUTO-23, AUTO-27, AUTO-28, AUTO-01, AUTO-13 | Regulatory deadlines, emergency-power expiry, sanctions latency, unscanned documents, expiring credentials and certificates, backup failures nobody sees. |
| 3. Operations | AUTO-07, AUTO-09, AUTO-11, AUTO-12, AUTO-15, AUTO-29, AUTO-30, AUTO-31, AUTO-32, AUTO-10 (scaling calibration) | Reconciliation, routing and reporting quality; needs AUTO-03 for alerting. |
| 4. Design completion | AUTO-14, AUTO-17, AUTO-18, AUTO-33, AUTO-10 (scale-down) | Larger changes or items whose intent must be confirmed. |

Each item ships as its own change: migration (if any), worker, env keys, tests, `05-workers.md` row, regenerated appendices, TRACKER row.

## 6. Decisions (researched 2026-11-09)

Nine open questions were researched against industry practice, the Libyan framework and the existing design, and all nine are decided below with defaults that fit the current architecture (D7 by the owner on 2026-11-09). Every number is a setting, not a constant, so it can be tuned without code. The regulatory catalogue in section 6.2 is a provisional default to be confirmed with the CBL.

### 6.1 Decided

| # | Question | Decision | Basis |
| :--- | :--- | :--- | :--- |
| D1 | Dispute evidence deadline outcome (AUTO-04) | **Lost by default, automatically.** Reminders to the merchant and the dispute queue at T-72 h and T-24 h. At `evidenceDueAt` with no evidence submitted: status `EXPIRED` (already in `DisputeStatus`), outcome recorded as lost by default, the held chargeback reserve is booked as lost (`CHARGEBACK_RESERVE_AND_LOST`, stage LOST), audit row and merchant notice. If evidence *was* submitted, nothing is decided automatically: the dispute waits for the provider's ruling and escalates when the ruling is overdue (`DISPUTE_RULING_SLA_DAYS`). A later provider ruling in the merchant's favour is booked with `CHARGEBACK_WON`, so the automatic outcome is reversible. | Card schemes do not accept late evidence; an unanswered dispute closes in the cardholder's favour without review, and funds are normally withdrawn at intake. The system mirrors the provider instead of inventing an outcome. |
| D2 | Cash-out SLA and escalation (AUTO-04) | **Measure the operator window only** (request to hand-off to the bank or rail), excluding time in a documented hold (KYB, AML, payout-account mismatch). Defaults: `CASHOUT_SLA_BUSINESS_HOURS=24`, reminder at 75 %, breach at 100 %, second breach at 200 %. Business days follow the Libyan week (Sunday to Thursday) in `Africa/Tripoli`, with a holiday calendar in platform settings. Recipients by authority, not by name: reminder to the cash-out processing queue (`cashout:process`); breach opens a P2 operator case for finance supervisors (`cashout:process` plus `approval:check`); second breach raises it to P1 and notifies compliance. Report P50/P90/P95 processing time on the dashboard. | Payout SLAs are vendor-defined, not standardised; good practice separates the operator window from third-party settlement, keeps exclusions narrow and documented, and reports percentiles so averages do not hide the long tail. The owner may tune the 24 h default; nothing blocks building. |
| D3 | Automatic regulatory reports (AUTO-16) | **Draft automatically, file by a person.** The design already defines `PERIODIC_RETURN`, `LARGE_TRANSACTION` and `SUSPICIOUS_ACTIVITY` report types with authority `CBL`. The worker creates DRAFT reports: one per `reporting_rules` period for periodic returns, and one per threshold breach for large transactions; it escalates drafts that pass their filing due date through AUTO-04. Suspicious-activity reports are drafted on trigger but are **never** filed automatically: the MLRO decides, and nothing reaches the merchant (tipping-off). No authority API adapter is built until the regulator's channel is known. | FATF Recommendation 20 requires prompt reporting of suspicion, and Recommendation 21 forbids tipping-off; Libya's Law No. 2 of 2005 creates the Financial Information Unit inside the CBL and requires reporting on detection. The returns, periods and due dates are the provisional catalogue in 6.2. Suspicious-activity and large-transaction reports are filed through the Financial Information Unit's goAML portal, which the CBL launched as the national reporting system. |
| D4 | Expired credential set (AUTO-08) | **Yes, take its routes out automatically.** Notices at 30, 7 and 1 days. At `expiresAt` the credential set becomes inactive and its routes go to `OPEN_BREAKER` (already in `HealthState`) with reason `CREDENTIALS_EXPIRED`, which routing already skips, plus a P1 case. If a rail has no other route, it is hidden from the payer's rail list instead of failing mid-payment. Repeated authentication failures (`401/403` from the token endpoint) do the same before the expiry date. The breaker's ordinary failure counting stays for transient errors only. | An authentication failure is persistent: retrying it cannot succeed and burns payer attempts. Orchestrators route away from failing processors automatically and log every failover; transient and persistent failures are treated differently. |
| D5 | Malware scanner (AUTO-06, GAP-025) | **ClamAV `clamd`, self-hosted**, called by the scan worker with the `INSTREAM` command over a Unix socket (or TCP on a dedicated scan host); `freshclam` keeps signatures current; `StreamMaxLength` raised to at least the KYB upload limit (25 MB). Fail closed: a scanner error or an unscanned file stays `PENDING`, never `CLEAN`. The deploy engine installs `clamav-daemon` on the scanning host behind `KYB_SCANNER_MODE=clamd` (it needs roughly 1 to 1.5 GB of RAM for signatures, so it is not enabled on small single-host labs by default). Scanning stays one layer next to the existing content-type sniffing, size limits and active-content checks. | Open source, no data leaves the deployment (KYB documents are identity documents), runs offline in the CBL-hosted environment, and is the common engine behind Node.js upload-scanning libraries. A commercial second engine can be added later behind the same port. |
| D6 | Shard width for system accounts at 15,000 TPS (AUTO-10) | **Formula, interim value, then measure.** Width = ceil(peak lines/s per account x shard lock hold time in seconds x 2). Every confirmation touches TREASURY or GATEWAY_CLEARING and PLATFORM_INCOME, so each sees about 15,000 lines/s at target. With today's estimated hold time of 3 to 6 ms that is 90 to 180 shards; with the lock-hold reduction in AUTO-10 (shard upsert as the last statement before commit, no in-transaction LSN query) it should fall to 1 to 2 ms, i.e. 30 to 60. Interim: provision those system accounts at **128** and raise `LEDGER_SHARD_MAX_WIDTH` from 64 to **256**; then measure lock hold and per-shard throughput with `core-back/test/load/ledger-load.ts` on the target hardware and set the final width from the formula. | Hot-row contention serialises updates to one row; the standard fix is slotted rows summed on read (what `gl_account_shards` already does) plus short transactions. Real numbers have to come from the system's own schema on its own hardware. This needs target hardware, not an owner decision. |
| D7 | Emergency action not ratified within 24 h (AUTO-22) | **Split policy (chosen by the owner).** Emergency velocity and limit changes are reverted to the last ratified values at 24 h. Emergency suspensions stay in force with a P1 escalation to the MLRO every 4 h, and are lifted at 24 h + 48 h unless ratified or extended once (up to 7 days) by a second compliance officer. Every step is audited and idempotent; the merchant learns only that a suspension ended. | Break-glass practice: emergency powers expire automatically and every use gets an independent review. Reverting a protective suspension at once could reopen a fraud or AML risk, so suspensions get a longer, escalated window before they lapse. |
| D8 | Commission netting (AUTO-21) | **Daily, partial, carry forward, pause at the ceiling.** A singleton job after the Tripoli day close (`COMMISSION_NETTING_CRON`, default 00:30 Africa/Tripoli) and also at cash-out time, before a cash-out is approved. It nets `min(receivable, available wallet balance - pending cash-outs)`, never below zero, posting the existing `NETTING` template. The remainder stays as receivable. When the receivable exceeds the merchant's `commissionReceivableCeiling` (already a merchant field) and cannot be netted, the existing `PAUSE` decision stops new merchant-direct attempts and the merchant is notified to settle; traffic resumes automatically when the receivable falls below the ceiling. Receivables older than `COMMISSION_RECEIVABLE_AGING_DAYS` (default 30) open a finance case. | Platforms that do not hold the funds collect their fee from the merchant's balance and recover a deficit later (debiting the merchant or holding a reserve); recovering against the merchant's balance at settlement time and pausing when exposure exceeds a limit is the same model with the controls this system already has. |
| D9 | Outbound merchant webhooks (AUTO-34) | **Yes, they are part of the product**: the merchant guide already documents them and generates verification code for them. Built as AUTO-34 with the Standard Webhooks signature scheme, exponential backoff with jitter for about a day, a dead-letter list and manual redelivery in the merchant portal. | Every payment gateway notifies merchants asynchronously; Standard Webhooks is the open convention for signing (`webhook-id`, `webhook-timestamp`, `webhook-signature`); senders use exponential backoff with a dead-letter queue rather than dropping messages. |

### 6.2 Provisional regulatory report catalogue (D3)

There is no published list of the returns a CBL-licensed payment company must file: the CBL lists Banking Supervision Circular No. 7 of 2020 and No. 10 of 2017 for electronic payment companies without their reporting annexes, the National Payments Council regulations are not public, and Law No. 2 of 2005 with its executive regulation (Decree No. 300 of 2007) leaves the reporting template to the Financial Information Unit, which now runs goAML. Until the compliance officer obtains the authoritative list, the system ships the catalogue below as **provisional defaults**. It is modelled on the FATF Recommendations, on what central banks commonly require from payment and e-money institutions, and on the data this platform already holds. Every row is a `reporting_rules` row with status `PROVISIONAL` and can be confirmed, changed or retired through maker-checker without code.

| Code | Type | Trigger and period | Due | Contents | Output and channel |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `STR` | `SUSPICIOUS_ACTIVITY` | Event: an AML case the MLRO decides to report (manual) or a seeded rule hit (for example LYD 50,000 aggregated within 24 h, the existing provisional rule) that the MLRO confirms | Internal targets: draft within 1 business day of the decision, MLRO decision within 2 business days; filed "without delay" per the 2005 law | Subject (merchant or payer), linked attempts and amounts, indicators and narrative written by the MLRO, screening results, supporting documents | goAML XML (STR) uploaded by the MLRO to the FIU goAML portal; never visible to the merchant |
| `LTR` | `LARGE_TRANSACTION` | Every attempt at or above the threshold (seeded rule: LYD 50,000, single transaction), batched per business day | Next business day | One line per transaction: reference, date, amount, currency, rail, merchant, payer identifiers held, status | goAML XML (threshold report) and XLSX; filed by the MLRO |
| `PSP-M` | `PERIODIC_RETURN` | Monthly | 10th day of the following month | Volume and value by rail and by merchant category, success, failure and UNKNOWN rates, refunds, chargebacks and dispute outcomes, cash-outs paid, active, onboarded and suspended merchants, funds position (sum of merchant wallets against treasury and clearing balances from reconciliation), service availability and incidents | XLSX with a cover summary, uploaded or sent to the CBL Payment Systems department |
| `AML-Q` | `PERIODIC_RETURN` | Quarterly | 15th day after quarter end | Screening volumes, matches and false positives, AML cases opened, closed and overdue, number of STRs filed (count only), KYB status distribution, high-risk merchants, re-verifications, staff AML training completion (from the Academy) | XLSX to the CBL compliance or supervision department |
| `AML-A` | `PERIODIC_RETURN` | Annual | 31 January | Annual figures of `AML-Q`, the institution's risk-assessment inputs (merchant risk tiers, rail risk, geographic exposure), policy and control changes, audit findings | XLSX plus a narrative the MLRO completes |
| `INC` | `PERIODIC_RETURN` (event subtype) | Event: a P0 platform incident from AUTO-03 lasting longer than 30 minutes, or any data or security breach | Initial notice within 24 h, final report within 10 business days | Start, end, affected rails and merchants, payments affected, cause, remediation | XLSX and narrative; filed by the compliance officer |

Rules that apply to every report: the payload is stored encrypted with its SHA-256 (already in the model); the draft is regenerated, never edited in place, until it is approved; an approved report is immutable; the submission reference and the authority's acknowledgement are recorded; period boundaries and due dates use `Africa/Tripoli` and the Libyan business-day calendar. Only one thing still depends on the regulator: confirming or replacing these rows. That is a configuration change, not a design decision, so nothing blocks implementation.

### 6.3 Sources

- Chargeback deadlines: [Disputifier, merchant does not respond](https://www.disputifier.com/post/what-happens-if-a-merchant-doesnt-respond-to-a-chargeback-consequences-and-fixes), [Racklify, evidence due date](https://racklify.com/encyclopedia/what-is-an-evidence-due-date/), [Chargeflow, why merchants lose](https://www.chargeflow.io/blog/reasons-merchants-lose-chargeback-disputes). These are vendor sources. The binding rule is the provider's own dispute rules, so `evidenceDueAt` must come from each rail.
- Payout SLAs: [Payrix payout cycle](https://resource.payrix.com/resources/payout-withdrawal-processing-cycle-timeline), [Fast withdrawal SLAs](https://bikes.fan/corpus/gen-2992/dynamic-business-process-management/fast-withdrawal-slas.html).
- Libya: [CBL electronic payment](https://cbl.gov.ly/en/electronic-payment/), [Law No. 2 of 2005 on anti-money laundering (DCAF)](https://security-legislation.ly/latest-laws/law-no-2-of-2005-on-anti-money-laundering/), [AML Watcher, Libya](https://amlwatcher.com/our-coverage/libya/).
- goAML in Libya: [CBL, the Libyan Financial Information Unit launches goAML](https://cbl.gov.ly/en/the-libyan-financial-information-unit-officially-launches-the-goaml-system-to-combat-money-laundering/), [APA News, Libya implements goAML](https://apanews.net/libya-implements-goaml-electronic-system-to-combat-financial-crime/); executive regulation: [Decree No. 300 of 2007 (DCAF)](https://security-legislation.ly/latest-laws/decree-no-300-of-2008-on-issuing-the-executive-regulation-of-law-no-2-of-2005-on-combating-money-laundering/).
- FATF: [Recommendation 20](https://cfatf-gafic.org/documents/fatf-40r/386-fatf-recommendation-20-reporting-of-suspicious-transactions), [Recommendation 21](https://cfatf-gafic.org/documents/fatf-40r/387-fatf-recommendation-21-tipping-off-and-confidentiality).
- Routing and failover: [Primer, processor failover](https://primer.io/blog/what-tools-help-merchants-manage-failover-between-payment-processors-without-downtime), [Lago, multi-PSP routing and failover](https://getlago.com/blog/payment-orchestration-multi-psp-routing-and-failover), [Spark, fallback routing](https://www.spark.money/glossary/fallback-routing).
- Malware scanning: [Transloadit, ClamAV in Node.js](https://transloadit.com/devtips/implementing-server-side-malware-scanning-with-clamav-in-node-js/), [clamav.js](https://github.com/yongtang/clamav.js).
- Hot rows: [Netdata, PostgreSQL row-lock contention](https://www.netdata.cloud/guides/postgres/postgres-row-level-lock-contention/), [slotted counter pattern](https://blog-1yx.pages.dev/building-with-postgresql-the-slotted-counter-pattern), [pgledger performance](https://pgrs.net/2025/05/16/pgledger-in-postgresql-is-fast/).
- Fee collection: [Stripe, direct charges](https://docs.stripe.com/connect/direct-charges), [Stripe, account balances](https://docs.stripe.com/docs/connect/account-balances), [Stripe, Connect risk](https://docs.stripe.com/connect/manage-risk).
- Emergency access: [Fitgap, break-glass without bypassing governance](https://us.fitgap.com/stack-guides/handling-break-glass-access-without-bypassing-governance), [Gravitee, break-glass procedures](https://gravitee.io/corpus/gen-1271/business-continuity-planning/emergency-access-and-break-glass-procedures.html).
- Webhooks: [Standard Webhooks](https://www.standardwebhooks.com/), [Svix, retries](https://www.svix.com/resources/webhook-best-practices/retries/), [Webhook best practices checklist](https://webhookrelay.com/blog/webhook-best-practices/).

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

## 9. Implementation status (kept current while the plan is built)

Canonical status lives in `project-design/TRACKER.md` and `project-design/parts/01-core-back/05-workers.md` section 3.16; this table is the quick view. "Dry run" means it ships audited-only until the owner switches it live (plan rule 2).

| Item | Status | Notes |
| :--- | :--- | :--- |
| AUTO-02 outbox dead-lettering | Done | Migration 16; parked events, one case per topic; relay and shipper report health. |
| AUTO-03 worker health and monitoring | Done | Registry, `PlatformMonitorWorker`, 8 standard checks + 2 money-path checks; backup freshness arrives with AUTO-27. |
| AUTO-10 repair lock time | Done | Plan outside the lock. Scaling (pre-sized system accounts, calibration) and scale-down are open. |
| AUTO-19 stale UNKNOWN | Done | Keyed case from `PollWorker`, monitor check. |
| AUTO-20 refund inquiry | Done, dry run | `REFUND_INQUIRY` jobs; production scheduler wired. |
| AUTO-21 commission netting | Done, dry run | Daily worker and cash-out hook, notification, aged case. |
| AUTO-25 KYB 200-merchant cap | Done | Persisted keyset cursor. |
| AUTO-01 journal partitions | Done | Function hardened (v17), worker, operator repair script. The plan's "guarded repair job" is an operator script because the maintenance flag is not available to the application role. |
| AUTO-13 join request follow-through | Done | Audit row and neutral merchant notice in the expiry transaction. |
| AUTO-05 expiry housekeeping | Done | `ApprovalState.EXPIRED` (v18), invitations, MFA/session purges, sealed-secret scrub. |
| AUTO-11 payment link expiry | Done | `link.expired` outbox event; slot self-healing stays with AUTO-12. |
| AUTO-04 SLA and deadline escalation | Done (D1 deviation) | Operator/AML/join/dispute/cash-out rules; dispute loss BOOKING stays human (design 19.3), owner to confirm. P50/P90/P95 dashboard not built. |
| AUTO-22 emergency ratification | Done | Policy D7 for suspensions; velocity reverter interface only (no emergency velocity flow exists); extension route + admin-back proxy, no UI button yet. |
| AUTO-08 token and credential expiry | Done (deviation) | Staged notices, P1 case, expired set taken out of use. No OPEN_BREAKER: routing already hides routes without a VERIFIED credential set. |
| AUTO-26 re-verification | Partly | Scheduled re-verification (dry run) and failing-verdict case. Refresh-failure counting in `ApiConsumer` not built. |
| AUTO-24 event-driven AML re-screening | Done | List-update sweep (resumable) and new-owner trigger; owner edits are not detected. |
| AUTO-23 reconciliation follow-up | Done (deviation) | Exception cases, chargeback rows to disputes, statement evidence on UNKNOWN cases; the UNKNOWN attempt is not finalised automatically. Also fixed: disputes had no evidence deadline and their approval expired in 3 days. |
| AUTO-06 KYB scanning | Done | `KybScanWorker` with a ClamAV `clamd` INSTREAM client, fail-closed retry/backoff, quarantine case and notice, re-scan after `KYB_RESCAN_DAYS`, backlog monitor check; `KYB_SCANNER_MODE=clamd` makes the deploy engine install and converge `clamav-daemon` + `freshclam` on every core host (loopback `127.0.0.1:3310`, `StreamMaxLength` 32M, restart only on change); an explicit `KYB_CLAMD_ADDRESS` means an external daemon and nothing is installed. |
| AUTO-27 backup alerts and audit anchor | Done (deviation) | `backup` monitor check polls the daemon overview (no push channel): unreachable, unhealthy, WAL lag, failed run per target, stale full backup, failed/stale drill, each its own keyed case. `AuditChainAnchorWorker` verifies the live chain incrementally and stores HMAC-signed anchors (`audit_chain_anchors`, v22); rewrite, truncation, break and forged anchor open P1 cases. The anchor is stored only in the core database (not yet copied to the backup store). |
| AUTO-28 certificate renewal | Done (deviation) | Deploy installs a certbot renewal timer (twice daily) and an Nginx reload deploy hook for `certbot` vhosts; a deploy re-issues internal mTLS leaves expiring within `MTLS_RENEW_WITHIN_DAYS` with the same CA; `deploy.ts --check-certs` reports expiry for cron/alerts. Nothing runs the deploy automatically, and a near-expiry CA still needs `--rotate-certs`. |
| AUTO-16 regulatory reports | Partly | `RegulatoryReportWorker` drafts PSP-M, AML-Q, AML-A per closed Tripoli period and the business-day LTR batch from PROVISIONAL `reporting_rules` rows (v23, `due_at`, idempotent per code and period); the `reports` deadline rule reminds and opens a P1 case. NOT built: goAML XML, XLSX output, the INC return, STR due dates, regenerate action. |
| AUTO-34 merchant webhooks | Done (partial scope) | Endpoints per application, vault-encrypted `whsec_` secret shown once with a 24 h rotation overlap, Standard Webhooks signing, outbox fan-out in the relay transaction, `MerchantWebhookWorker` (pinned public egress, no redirects, 8 attempts over ~27 h, park, disable after 5 days with a notice), `webhook.test`, redeliver, core API + merchant-back proxy + portal page, guide updated. Events: payment succeeded/failed/expired/refunded (terminal status), link expired, dispute opened/closed, cash-out paid/failed. NOT built: attempt history, payload viewer, partial-refund event. |
| AUTO-07 statement schedules | Partly | `StatementScheduleWorker` + `lib/cron.ts` (Tripoli time): one keyed case per missed slot, resolved when the statement arrives. No `STATEMENT_FETCH` pull job (no connector) and no AUTO-15 sweep scheduling. |
| AUTO-12 slot self-healing | Partly | `ConsistencyAuditWorker` reports `active_locked_count` drift (repair behind a flag, off by default). Daily cap counters are not audited. |
| All other items | Open | See the roadmap in section 5. |
