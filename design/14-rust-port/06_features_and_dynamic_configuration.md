# Chapter 6 — Features and Dynamic Configuration (Track E)

> Part of the Rust/ntex port plan (`porting_to_ntex_rust.md`). These items start after the P10 gate unless marked
> otherwise. Each item lists the problem it solves (with source), the design (tables, APIs, behaviour), migration and
> acceptance criteria. New HTTP endpoints are **additive** and versioned; existing contracts keep working.

---

## 1. Principles

1. **Behaviour as data, safety as code.** Values operators legitimately tune (thresholds, schedules, retry policies,
   SLAs, role mappings, calendars, regulator catalogues) move into versioned, approved, audited data. Invariants that
   protect money (the attempt state machine, ledger templates, lock order) stay in code and change only through
   releases.
2. **The server owns the schema of its configuration.** The frontend renders configuration forms from JSON Schemas
   served by core, so a new setting is a single backend change (today: seed + core reader + admin-front catalogue +
   EN/AR i18n, `docs/developer/platform-settings.md`).
3. **Every runtime change is versioned, attributed, optionally approval-gated, propagated to all nodes within
   seconds, and reversible.**

---

## 2. E-F01 Configuration registry

**Problem:** settings catalogue lives in the frontend (`settingsCatalog.ts`); only three readers cache (5 s, local
node only); `effectiveFrom` honoured inconsistently; 10 seeded settings are never read (OD-1/3/5/6/7/8/9/11 and
others, `core-back/prisma/platformSettingsSeed.ts`); several keys are read but not seeded (`checkout.support_config`,
`communication.*`, `auth.google`, `goaml.*`); only PLATFORM scope used.

**Design**

- Code-owned definitions (`pg-config::registry`): each key declares `key`, `version`, JSON Schema (generated with
  `schemars` from a Rust type), allowed scopes (`PLATFORM`, `JURISDICTION`, `GATEWAY`, `RAIL`, `MERCHANT`,
  `APPLICATION`), default, sensitivity (`public` | `internal` | `secret`), `requires_approval` (bool or subject type),
  `reload` (`live` | `restart`), owner team, EN/AR label and help keys.
- At boot core upserts definitions into `config_definitions(key PK, schema_json, scopes text[], default_json,
  sensitivity, requires_approval, reload, labels_json, definition_version, updated_at)`.
- Values extend the existing `platform_settings` table (keeps history): add `scope_type`, `scope_id`,
  `effective_to`; unique `(key, scope_type, scope_id, version)`; secrets stay in `platform_setting_secrets`.
- Resolution order: APPLICATION → MERCHANT → RAIL → GATEWAY → JURISDICTION → PLATFORM → definition default; first
  value whose `[effective_from, effective_to)` contains `now()` wins. Resolution returns `(value, source, version)`.
- Cache: per-key in-process map with version; invalidation via the bus topic `configuration:<key>` on every write
  (fixes "local node only"); scheduled activation: a worker publishes invalidation at each future `effective_from`.
- API (admin, versioned `/internal/admin/config/v1`): `GET definitions` (schemas + labels → dynamic forms),
  `GET values?key=&scope=` (with resolution trace), `PUT values` (validates against schema; creates approval when
  required), `GET history`, `POST rollback` (re-activates a previous version through the same approval rules).
- Migration of existing keys: every key read by code gets a definition; unread seeded keys are resolved by the
  decision table in §13.

**Acceptance:** adding a setting needs only a Rust definition; a value change reaches every node in < 2 s; approval
enforced for sensitive keys; history and rollback work.

---

## 3. E-F02 Runtime worker control

**Problem:** worker intervals, batch sizes, enable flags and dry-run flags are env-only (restart needed);
`WORKER_CONCURRENCY` / `WORKER_REQUEST_TIMEOUT_MS` unused; no per-worker health endpoint.

**Design**

- Table `worker_controls(name PK, enabled, interval_ms, batch_size, concurrency, dry_run, paused_until, version,
  updated_by, approval_request_id, updated_at)` seeded from env defaults at first boot.
- Workers read their control row at each tick (cached with bus invalidation `configuration:worker:<name>`).
- Disabling or pausing a money-critical worker (outbox relay, ledger checkpoint/invariant, expiry sweeper, poll,
  merchant webhook, background jobs) requires approval and raises a P1 operator case while disabled.
- `GET /internal/admin/workers/v1` returns per-worker state: leader node, last tick, duration p50/p95, last error,
  backlog, next run; feeds an admin page and the metrics endpoint.
- Env vars remain as **bootstrap defaults only**.

---

## 4. E-F03 Feature flags

- Table `feature_flags(key PK, description, enabled, rules_json, version, updated_by, updated_at)`; rules: plane
  allow-list, merchant/application allow/deny lists, percentage rollout by `fnv1a32(merchantId) % 100`, start/end time.
- Evaluated in-process from a bus-invalidated cache; every evaluation result can be attached to traces.
- Used to roll out every Track E behaviour change (e.g. async inbound inbox per gateway, PII exact search).

---

## 5. E-F04 Policy as data

| Policy | Today (source) | Target table | Notes |
| :--- | :--- | :--- | :--- |
| Retry schedules | webhook delays `events.ts:63`, poll backoff `PollWorker.ts:81`, refund inquiry `RefundInquiry.ts:37-41`, notification max attempts `OutboxNotificationWorker.ts:53`, outbox max attempts | `retry_policies(name, delays_ms int[], jitter_pct, max_attempts, version)` | workers reference by name; per-endpoint override for webhooks (E-F08) |
| SLAs | AML SLA hours `AmlRuleEngine.ts:95-106`, operator case P1/P2/P3 `caseCatalog.ts:85-105`, unknown-attempt SLA, cash-out SLA, KYB warning days | `sla_policies(domain, severity_or_priority, hours, business_hours bool)` | business-hours computed with the jurisdiction calendar (E-F05) |
| Approval checker roles | `DOMAIN_CHECKER_ROLES` `GovernanceExecution.ts:4154-4176`, `REPORT_DRAFT_ROLES`, `RATIFIER_ROLES`, `FILERS` | `approval_policies` (E-F06) | |
| Operator case catalogue | code `caseCatalog.ts` | `case_types(code, default_priority, sla_policy, labels_json, context_presenter)` | presenters stay code, keyed by code |
| AML escalation | constants `AmlRuleEngine.ts:84-106`, volume multiple 3, window cap 1000 | `aml_policies` (versioned, MLRO approval) | rule types stay a closed enum |
| Trusted success statuses | `DynamicRailEngine.ts:330` | gateway spec v1.1 field `trusted_success_statuses` (default = today's list) | per gateway version, immutable once LIVE |
| Collection TTL ceilings | OD-7 (unread) | config key `collection.ttl_ceilings` actually enforced | |
| Status → webhook event mapping | `events.ts:26` | stays code (contract with merchants) | documented in the event catalogue |

---

## 6. E-F05 Regionalisation

**Problem:** Africa/Tripoli, Sunday–Thursday business week, LYD fallbacks and CBL regulator specifics are hard-coded in
many places (`DailyRouteVolume.ts:8`, `businessTime.ts:7,10`, `CommissionNettingWorker.ts:104-105`,
`StatementIngestor.ts:636`, `regulatory/periods.ts:5`, `baselineSchemas.ts`, `GovernanceExecution.ts:714,721,1843,…`,
`AttemptGuardPipeline.ts:301`, `CanonicalReportContext.ts:216,267`, schema defaults `country "LY"`, `authority
"CBL"`, `currency "LYD"`).

**Design**

- `jurisdictions(code PK, name_json, timezone, business_weekdays int[], base_currency, regulator_code, active)`;
  seed `LY` with today's values.
- `business_calendar(jurisdiction, date, kind HOLIDAY|HALF_DAY|WORKDAY_OVERRIDE, label_json)` replacing
  `calendar.holidays`.
- `regulator_profiles(code PK, name_json, report_types_json)`: report types (PSP-M, AML-Q, AML-A, LTR, STR, INC),
  periods, output formats, schema ids, filing adapter — replacing `RegulatoryReportWorker.ts:181,203-233` and
  `ReportingRuleEvaluator.ts:204-209` constants.
- Deployment config key `platform.jurisdiction` (default `LY`); every fallback reads the jurisdiction instead of a
  literal. A CI grep forbids new literals `"Africa/Tripoli"`, `"LYD"`, `"CBL"` outside seeds.

---

## 7. E-F06 Approvals v2

**Problem:** no handler for `APPLICATION`, `CASHOUT_REQUEST`, `PLATFORM_SETTING`; single-actor writes for cash-out,
settings, commission/velocity creation, backup trigger/drill/restore; `DetailChangeService` unwired; checker roles in
code.

**Design**

- `ApprovalSubject` trait in `pg-domain-gov`: `validate_draft`, `diff`, `checker_rules`, `execute(tx)`,
  `on_reject`. Every subject type registers an implementation; the executor is generic.
- `approval_policies(subject_type, required_approvals int default 1, checker_roles text[], maker_roles text[],
  expiry_hours, allow_emergency bool, ratification_hours, version)` — supports 2-of-N where configured.
- Coverage: add subjects `APPLICATION`, `CASHOUT_REQUEST`, `PLATFORM_SETTING` (via E-F01), `COMMISSION_PROFILE`
  (create), `VELOCITY_RULE` (create), `BACKUP_TRIGGER`, `RESTORE_DRILL`, `WORKER_CONTROL`, `FEATURE_FLAG`,
  `POS_TERMINAL` (S-SEC-12), `CONFIG_DEFINITION_OVERRIDE`.
- Wire `DetailChangeService` for field-level change history on merchants/applications.
- Behaviour change: actions that were immediate become approval-gated per policy; ship each subject behind a feature
  flag with default policy `required_approvals = 1, checker ≠ maker`.

---

## 8. E-F07 Rails v2

- Implement executors for **CAPTURE**, **SETTLEMENT_FETCH**, **CANCEL** phases (spec already models them).
- Wire the **native adapter registry** (`NativeAdapterRegistry.ts`) for rails that cannot be expressed declaratively.
- **Sandboxed extensions** (optional, flag-gated): compute operations and canonicalisation modes as WebAssembly
  modules run by `wasmtime` 51 with fuel limits, 16 MiB memory cap, no WASI filesystem/network/clock (deterministic),
  input/output as JSON bytes; modules uploaded as signed artefacts through the `RAIL_EXTENSION` approval subject and
  pinned by SHA-256 in the gateway version; simulator runs them offline against spec test vectors.
- Spec version 1.1 (backward compatible with 1.0): `trusted_success_statuses`, `client_action_mapping`, phase
  definitions for CAPTURE/SETTLEMENT_FETCH/CANCEL, `extensions[]` references, per-gateway inbound `ack_mode` (E-F09)
  and required callback signature policy (E-SEC-09).
- Fix fake-rails fidelity gaps (GAP-004/080: 13 of 20 descriptors seeded, code mismatches `cbl_lypay`/`ly_pay`,
  `evo_pay`/`evopay`, wrong default webhook paths, six phases not emulated).

---

## 9. E-F08 Event platform

- `merchant_events(id bigint identity, merchant_id, application_id, type, schema_version, payload_json, created_at)`
  partitioned monthly, retention configurable per jurisdiction (default 13 months), written by the outbox relay for
  every merchant-visible topic.
- Replay API: `GET /api/v1/merchant/events?cursor=&types=` (portal) and `GET /api/v1/external/events?cursor=` (API
  token scope `event:read`), keyset by id.
- `webhook_delivery_attempts(delivery_id, attempt_no, started_at, duration_ms, status_code, error_class,
  response_snippet_enc)` — full attempt history (today only the last attempt is kept).
- Per-endpoint retry policy (references `retry_policies`), manual redelivery API, endpoint health score.
- Published event catalogue: versioned JSON Schemas per event type (`GET /api/v1/external/events/schema`).

---

## 10. E-F09 Asynchronous inbound callbacks

**Problem:** callbacks are verified and processed synchronously before acknowledging; `InboundInboxWorker` has no
producer; the edge's 10 s timeout can report failure while core still completes (SC-027).

**Design:** per-gateway `ack_mode` = `SYNC` (today) | `ASYNC`. In ASYNC: core verifies the signature (cheap), stores
raw bytes and headers in `inbound_events` (dedupe key), commits, returns the gateway-expected acknowledgement body
immediately; `InboundInboxWorker` processes with existing transient-error classification; duplicates are harmless.
Rollout per gateway through a feature flag after the fake-rails duplicate/out-of-order suite passes.

---

## 11. Other features

| ID | Feature | Problem (source) | Design summary |
| :--- | :--- | :--- | :--- |
| E-F10 | SSE v2 | SSE polls the DB every 2–3 s; no resume (SC-028) | subscribe to the realtime bus; per-attempt monotonically increasing event id; `Last-Event-ID` resume from a 15-minute ring buffer; DB poll only as fallback when Redis is down |
| E-F11 | OpenAPI for merchant APIs | no machine-readable contract | generate OpenAPI 3.1 from the route policy registry + `schemars` schemas; publish at `/api/v1/external/openapi.json`; contract tests |
| E-F12 | Reconciliation formats | XLSX parser unwired; CSV/JSON only | enable XLSX (`calamine`); add MT940 and ISO 20022 camt.053 parsers (`quick-xml`); per-statement-source column mappings stored as data |
| E-F13 | Accounting defect fixes | GAP-008 (partial refund posts full-refund scenario; INTERNAL rails with payer surcharge cannot balance; AML release books no fee accrual; resolver credits the merchant's first wallet; `SYSTEM_AUTOMATION` not a UUID; refund commission splits > 4 dp), GAP-015 residual (merchant-direct hold escrow) | one fix per sub-item with ledger scenario tests and finance sign-off; versioned scenario templates |
| E-F14 | Report engine improvements | GAP-040 asset bytes not stored; no signed asset delivery; no merchant scheduling/email | store asset bytes in object storage; signed short-lived URLs; scheduled merchant reports delivered via the communication engine |
| E-F15 | Search v2 | ILIKE contains only, JS ranking | PostgreSQL FTS (`tsvector` generated columns with `simple` + Arabic-aware normalisation function) plus trigram for codes; ranking in SQL; replica reads; benchmark deep search |
| E-F16 | Merchant API v2 | scopes enforced only on `/external`; offset pagination | API tokens v2 (E-SEC-04); keyset everywhere (E-DB-13); idempotency keys on all POST endpoints with a generic `idempotency_records` table (TTL 24 h) |
| E-F17 | Notification templates as data | ~15 files of inline EN/AR text; auth templates code-owned | all templates seeded into `notification_templates` from code at boot (code version wins until an operator customises); admin editing with preview, variable validation, tipping-off check at save, per-recipient language preference |
| E-F18 | Operations console data | no worker health, no platform metrics in UI | APIs for workers (E-F02), queues (outbox/job backlog), replica lag, cert expiry, backup status — consumed by admin-front |
| E-F19 | Sandbox improvements | GAP-069/070: sandbox two-DB deploy never run live; no live→sandbox reference data sync; no role preview | pgctl provisions the sandbox plane end to end; `sandbox sync` job copies operator-customised reference data (gateways, rails, templates, settings) with an audit trail |

---

## 12. Acceptance for every E-F item

1. Design reviewed and recorded in the tracking part; 2. feature flag created; 3. tests (unit, integration, IDOR where
relevant); 4. admin/merchant API documented; 5. frontend changes delivered by the frontend team where needed; 6.
rollout plan with metrics; 7. TRACKER entry.

---

## 13. Decision table for existing unread or mismatched settings

| Key | Today | Decision |
| :--- | :--- | :--- |
| OD-1 `{mode:"PROVISIONAL"}` | record only | move to `regulator_profiles.status`; delete key |
| OD-2 four-eyes policy | read as alias | fold into `join_request.four_eyes_policy`; delete alias after migration |
| OD-3 screening provider | unread | becomes config `screening.provider` actually used to select the provider |
| OD-4 KYB retention years | read by RetentionWorker | becomes config `retention.kyb_years` |
| OD-5 neompay staging note | unread | delete (documentation, not configuration) |
| OD-6 owner threshold | unread (duplicated in four-eyes policy) | delete; single source in `join_request.four_eyes_policy` |
| OD-7 collection TTL ceilings | unread | enforce as `collection.ttl_ceilings` (E-F04) |
| OD-8 negative balance ceiling | unread (per-merchant column used) | delete; keep the per-merchant column with a platform default config |
| OD-9 ratification window/roles | unread (roles hard-coded) | move into `approval_policies` (E-F06) |
| OD-11 checker roles | unread | move into `approval_policies` |
| Keys read but not seeded (`checkout.support_config`, `communication.*`, `auth.google`, `goaml.*`) | defaults in code | get registry definitions with explicit defaults |
